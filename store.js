const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

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

// In-memory event log
let eventLog = [];

// REST API Endpoints
// app.post('/broadcast', (req, res) => {
//     const { event, data } = req.body;

//     if (event && data) {
//         io.emit(event, data);
//         console.log(`Broadcasted event: ${event}`, data);

//         eventLog.push({ event, data, timestamp: new Date() });
//         res.status(200).json({ message: 'Event broadcasted successfully.' });
//     } else {
//         res.status(400).json({ message: 'Invalid event or data.' });
//     }
// });

app.post('/broadcast', (req, res) => {
    const { socket_id, user_email, user_id } = req.body;

    // Log the details before emitting the event
    console.log('Broadcasting to socket:', socket_id);
    console.log('User email:', user_email);
    console.log('User ID:', user_id);

    if (socket_id && user_email && user_id) {
        try {
            // Emit the user_registered event to the specified socket_id
            if (io.sockets.connected[socket_id]) {
                io.sockets.connected[socket_id].emit('user_registered', {
                    user_email: user_email,
                    user_id: user_id
                });

                // Log the event broadcast
                console.log(`Broadcasted 'user_registered' to socket: ${socket_id}`);

                // Respond with success
                res.status(200).json({ message: 'Event broadcasted successfully to the socket.' });
            } else {
                // Socket ID not found
                console.log(`Socket with ID ${socket_id} not found.`);
                res.status(404).json({ message: 'Socket ID not found.' });
            }
        } catch (error) {
            // Log any errors that occur during broadcasting
            console.error('Error while broadcasting event:', error);
            res.status(500).json({ message: 'Error broadcasting event', error: error.message });
        }
    } else {
        // Missing required fields in the request
        console.log('Invalid request data:', req.body);
        res.status(400).json({ message: 'Invalid event data. socket_id, user_email, and user_id are required.' });
    }
});

app.get('/events', (req, res) => {
    const { page = 1, limit = 10 } = req.query;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    const paginatedLogs = eventLog.slice(startIndex, endIndex);
    res.status(200).json({
        page: parseInt(page),
        limit: parseInt(limit),
        total: eventLog.length,
        logs: paginatedLogs,
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({ message: 'Server is up and running!' });
});

// Socket.IO Event Listeners
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Store socket_id in the database for authenticated users
    socket.on('register_socket', async (data) => {
        const { user_id, role } = data; // role can be 'user' or 'driver'
        if (!user_id || !role) {
            console.error('Missing user_id or role');
            return;
        }

        // Emit to Laravel backend to store the socket_id
        const storeData = {
            socket_id: socket.id,
            user_id,
            role,
        };
        io.emit('store_socket_id', storeData);

        console.log(`Socket ID registered for ${role} ${user_id}: ${socket.id}`);
        eventLog.push({ event: 'register_socket', data: storeData, timestamp: new Date() });
    });

    // Join user and driver rooms
    socket.on('join_user', (userId) => {
        const room = `user_${userId}`;
        socket.join(room);
        console.log(`User ${userId} joined room`);
        eventLog.push({ event: 'join_user', data: { userId }, timestamp: new Date() });
    });

    socket.on('join_driver', (driverId) => {
        const room = `driver_${driverId}`;
        socket.join(room);
        console.log(`Driver ${driverId} joined room`);
        eventLog.push({ event: 'join_driver', data: { driverId }, timestamp: new Date() });
    });

    // Events for rides
    socket.on('ride_created', (data) => {
        const { driver_ids } = data;
        driver_ids.forEach(driver_id => {
            io.to(`driver_${driver_id}`).emit('ride_created', data);
        });
        console.log('Ride Created:', data);
        eventLog.push({ event: 'ride_created', data, timestamp: new Date() });
    });

    socket.on('accept_ride', (data) => {
        io.to(`user_${data.user_id}`).emit('ride_accepted', data);
        console.log('Ride Accepted:', data);
        eventLog.push({ event: 'accept_ride', data, timestamp: new Date() });
    });

    socket.on('reject_ride', (data) => {
        io.to(`user_${data.user_id}`).emit('ride_rejected', data);
        console.log('Ride Rejected:', data);
        eventLog.push({ event: 'reject_ride', data, timestamp: new Date() });
    });

    socket.on('cancel_ride', (data) => {
        io.to(`user_${data.user_id}`).emit('ride_canceled', data);
        if (data.driver_id) {
            io.to(`driver_${data.driver_id}`).emit('ride_canceled', data);
        }
        console.log('Ride Canceled:', data);
        eventLog.push({ event: 'cancel_ride', data, timestamp: new Date() });
    });

    socket.on('end_trip', (data) => {
        io.to(`user_${data.user_id}`).emit('trip_ended', data);
        if (data.driver_id) {
            io.to(`driver_${data.driver_id}`).emit('trip_ended', data);
        }
        console.log('Trip Ended:', data);
        eventLog.push({ event: 'end_trip', data, timestamp: new Date() });
    });

    // Location updates
    socket.on('update_driver_location', (data) => {
        io.to(`user_${data.user_id}`).emit('driver_location_updated', data);
        console.log('Driver Location Updated:', data);
        eventLog.push({ event: 'update_driver_location', data, timestamp: new Date() });
    });

    // Driver enroute and arrival events
    socket.on('driver_enroute', (data) => {
        io.to(`user_${data.user_id}`).emit('driver_enroute', data);
        console.log('Driver Enroute:', data);
        eventLog.push({ event: 'driver_enroute', data, timestamp: new Date() });
    });

    socket.on('driver_arrived', (data) => {
        io.to(`user_${data.user_id}`).emit('driver_arrived', data);
        console.log('Driver Arrived:', data);
        eventLog.push({ event: 'driver_arrived', data, timestamp: new Date() });
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected:', socket.id);
        eventLog.push({ event: 'disconnect', data: { socketId: socket.id }, timestamp: new Date() });
    });
});

// Start the server
const PORT = 3322;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
