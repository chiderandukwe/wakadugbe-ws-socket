require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    transports: ['websocket'],
});

// Constants
const LARAVEL_BASE_URL = 'https://wakajugbe.sky51event.uk'; // Change to your Laravel app URL
const LOG_FILE_PATH = path.join(__dirname, 'server.log');

// Helper: Append to log file with spacing between logs
function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n\n`;
    fs.appendFileSync(LOG_FILE_PATH, logMessage);
}

// Room management
let roomAssignments = {};

// Endpoint to broadcast events from Laravel
app.post('/broadcast', (req, res) => {
    const { event, data, room } = req.body;
    console.log('Received event:', event, 'with data:', data);

    if (event && data) {
        if (room) {
            io.to(room).emit(event, data);
            logToFile(`Broadcasted event: ${event} to room: ${room} | Data: ${JSON.stringify(data)}`);
        } else {
            io.emit(event, data);
            logToFile(`Broadcasted event: ${event} to client | Data: ${JSON.stringify(data)}`);
        }
        return res.status(200).json({ message: 'Event broadcasted successfully.' });
    }
    logToFile('Invalid broadcast request received.');
    res.status(400).json({ message: 'Invalid event or data.' });
});

// Socket.IO event listeners
io.on('connection', (socket) => {
    logToFile(`A user connected: ${socket.id}`);

    // Join room
    socket.on('join_room', (room) => {
        socket.join(room);
        roomAssignments[socket.id] = room;
        logToFile(`Socket ${socket.id} joined room: ${room}`);
    });

    // Leave room
    socket.on('leave_room', (room) => {
        socket.leave(room);
        delete roomAssignments[socket.id];
        logToFile(`Socket ${socket.id} left room: ${room}`);
    });

    // Handle predefined events from the Flutter app
    const eventHandlers = {
        ride_created: async (data) => {
            await forwardEventToLaravel(socket, 'ride_created', data);
        },
        accept_order: async (data) => {
            await forwardEventToLaravel(socket, 'accept_order', data);
        },
        reject_order: async (data) => {
            await forwardEventToLaravel(socket, 'reject_order', data);
        },
        cancel_order: async (data) => {
            await forwardEventToLaravel(socket, 'cancel_order', data);
        },
        driver_enroute_to_rider: async (data) => {
            await forwardEventToLaravel(socket, 'driver_enroute_to_rider', data);
        },
        driver_arrived: async (data) => {
            await forwardEventToLaravel(socket, 'driver_arrived', data);
        },
        driver_waiting: async (data) => {
            await forwardEventToLaravel(socket, 'driver_waiting', data);
        },
        update_driver_location: async (data) => {
            await forwardEventToLaravel(socket, 'update_driver_location', data);
        },
        start_trip: async (data) => {
            await forwardEventToLaravel(socket, 'start_trip', data);
        },
        end_trip: async (data) => {
            await forwardEventToLaravel(socket, 'end_trip', data);
        }
    };

    // Listen for dynamic events
    socket.onAny(async (event, data) => {
        const handler = eventHandlers[event];
        if (handler) {
            logToFile(`Received event: ${event} | Data: ${JSON.stringify(data)}`);
            await handler(data);
        } else {
            logToFile(`Unhandled event: ${event} | Data: ${JSON.stringify(data)}`);
            socket.emit(event, { status: 'error', message: 'Unhandled event type' });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const room = roomAssignments[socket.id];
        if (room) {
            logToFile(`Socket ${socket.id} disconnected from room: ${room}`);
            delete roomAssignments[socket.id];
        } else {
            logToFile(`Socket ${socket.id} disconnected.`);
        }
    });
});

// Helper function to forward events to Laravel
async function forwardEventToLaravel(socket, event, data) {
    try {
        // Send event to Laravel
        const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/events`, {
            event: event,
            data: data
        });

        if (event === 'ride_created') {
            const orderData = response.data.order; 
            const rideTypeData = response.data.ride_type;

            // Emit the 'ride_created' event back to the Flutter client
            socket.emit('ride_created', {
                status: 'success',
                message: 'Ride created successfully.',
                order: orderData,
                ride_type: rideTypeData
            });

            // Log the event forwarding to Laravel
            logToFile(`Ride created successfully: Order ID ${orderData.id} | Ride Type: ${rideTypeData.name}`);
        }

        // Emit success event back to the Flutter client for other events
        socket.emit(event, {
            status: 'success',
            message: `${event} handled successfully.`,
            data: response.data,
        });

        logToFile(`Event forwarded to backend: ${event} | Response: ${JSON.stringify(response.data)}`);
    } catch (error) {
        const errorMessage = error.response?.data || error.message;
        socket.emit(event, {
            status: 'error',
            message: `Failed to handle ${event}.`,
            error: errorMessage,
        });

        logToFile(`Error forwarding event to backend: ${event} | Error: ${JSON.stringify(error.response?.data || error.message)}`);
    }
}

app.get('/logs', (req, res) => {
    fs.readFile(LOG_FILE_PATH, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Error reading log file.');
        }

        // Try to parse the log file content as JSON
        try {
            // Attempt to parse the log data as JSON for pretty printing
            const parsedData = JSON.parse(data);

            // Format the JSON with indentation for readability
            const formattedData = JSON.stringify(parsedData, null, 2);

            // Wrap the formatted JSON in a <pre> tag for preformatted text
            res.send(`<pre style="white-space: pre-wrap; word-wrap: break-word;">${formattedData}</pre>`);

        } catch (e) {
            // If parsing fails, return the raw data (possibly plain text or malformed JSON)
            res.send(`<pre style="white-space: pre-wrap; word-wrap: break-word;">${data}</pre>`);
        }
    });
});

// Start the server
const PORT = process.env.PORT || 3322;
server.listen(PORT, () => {
    logToFile(`Server running on http://localhost:${PORT}`);
    console.log(`Server running on http://localhost:${PORT}`);
});
