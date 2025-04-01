require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { status, type } = require('express/lib/response');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    transports: ['polling','websocket'],
    pingTimeout: 60000,
    pingInterval: 25000,
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

// Constants
const LARAVEL_BASE_URL = 'https://wakajugbe.sky51event.uk';
// const LARAVEL_BASE_URL = 'http://localhost:8000';
const LOG_FILE_PATH = path.join(__dirname, 'server.log');

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

function handleAxiosError(error, context) {
    if (error.response) {
        logToFile(`${context}: ${error.message}`);
        logToFile(`Response Data: ${JSON.stringify(error.response.data)}`);
        logToFile(`Response Status: ${error.response.status}`);
        logToFile(`Response Headers: ${JSON.stringify(error.response.headers)}`);
    } else if (error.request) {
        logToFile(`${context}: No response received`);
        logToFile(`Request: ${JSON.stringify(error.request)}`);
    } else {
        logToFile(`${context}: ${error.message}`);
    }
}

// Helper function to forward events to Laravel
async function forwardEventToLaravel(socket, event, data) {
    try {
        // Send event to Laravel
        const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
            event: event,
            data: data
        });

        console.log('ORDER DATA', data);
        logToFile('ORDER DATA', data);

        // Emit success event back to the client
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

//Check ride status
async function checkRideStatus(orderId) {
    try {
        const response = await axios.get(`${LARAVEL_BASE_URL}/api/v2/order-status/${orderId}`);
        return response.data.status;
    } catch (error) {
        console.error('Error checking ride status:', error);
        return null;
    }
}


// function calculateDistance(lat1, lon1, lat2, lon2) {
//     const R = 6371000; // Radius of Earth in meters
//     const toRadians = (degree) => degree * (Math.PI / 180);
    
//     const dLat = toRadians(lat2 - lat1);
//     const dLon = toRadians(lon2 - lon1);
    
//     const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
//               Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
//               Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
//     const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//     return R * c; // Distance in meters
// }

const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
};





// Predefined event handlers
const eventHandlers = {
    ride_created: async (socket, data) => {
        try {
            logToFile(`ride_created event triggered with data: ${JSON.stringify(data, null, 2)}`);
    
            if (!data.order) {
                logToFile('Invalid data received for ride_created event');
                return;
            }
    
            const { order } = data;
            const fromLat = parseFloat(order.from_lat);
            const fromLong = parseFloat(order.from_long);
            const radius = data.radius || 2000; // Default radius 2km
    
            logToFile(`Requesting nearby drivers from Laravel API with: from_lat=${fromLat}, from_long=${fromLong}, radius=${radius}`);
    
            // Call Laravel API to get nearby drivers
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/find-nearby-drivers`, {
                from_lat: fromLat,
                from_long: fromLong,
                radius: radius,
            });            
    
            // Log the raw response from Laravel
            logToFile(`Response from Laravel API: ${JSON.stringify(response.data, null, 2)}`);
    
            if (response.data.status !== 'success') {
                logToFile('No available drivers found within radius.');
                return;
            }
    
            const nearbyDrivers = response.data.data;
            logToFile(`Nearby drivers found: ${nearbyDrivers.length}`);
    
            let emittedCount = 0; // Counter for emitted drivers

            for (const driver of nearbyDrivers) {
                const driverDistance = calculateDistance(fromLat, fromLong, driver.latitude, driver.longitude);
                
                logToFile(`Driver ${driver.id} is ${driverDistance.toFixed(2)} km away`);

                if (driverDistance <= radius / 1000) { // Ensure driver is within the specified radius
                    io.emit('ride_created', {
                        status: 'success',
                        data: {
                            order,
                            ride_type: data.ride_type,
                            user: data.user,
                            driver
                        }
                    });

                    emittedCount++; 
                    logToFile(`✅ Ride event emitted for Driver ${driver.id} (Distance: ${driverDistance.toFixed(2)} km)`);
                } else {
                    logToFile(`❌ Skipped Driver ${driver.id} (Distance: ${driverDistance.toFixed(2)} km, exceeds limit of ${radius / 1000} km)`);
                }
            }

            logToFile(`Total emitted drivers: ${emittedCount}`);

    
            // Forward event to Laravel
            await forwardEventToLaravel(socket, 'ride_created', data);
    
        } catch (error) {
            logToFile(`Error in ride_created handler: ${error.message}`);
        }
    },              

    accept_order: async (socket, data) => {
        try {
            logToFile(`accept_order event triggered for socket ${socket.id} with data: ${JSON.stringify(data)}`);
    
            if (!data.order || !data.order.id) {
                logToFile(`Error: Invalid order data received. Data: ${JSON.stringify(data)}`);
                socket.emit('accept_order_response', {
                    status: 'error',
                    message: 'Invalid order data.',
                });
                return;
            }
    
            const orderId = data.order.id;
            logToFile(`Checking order ID: ${orderId}`);
    
            const orderResponse = await axios.get(`${LARAVEL_BASE_URL}/api/v2/order-status/${orderId}`);
            logToFile(`Order status response: ${JSON.stringify(orderResponse.data)}`);
    
            if (!orderResponse.data?.order?.status) {
                logToFile(`Error: Invalid order status received from backend.`);
                socket.emit('accept_order_response', {
                    status: 'error',
                    message: 'Invalid order status received.',
                });
                return;
            }
    
            if (orderResponse.data.order.status === 'driver_accepted') {
                logToFile(`Ride ${orderId} already accepted by another driver.`);
                socket.emit('ride_alreay_taken', {
                    status: 'error',
                    message: 'This ride has already been accepted by another driver.',
                    order_id: orderId,
                });
                return;
            }
    
            await forwardEventToLaravel(socket, 'accept_order', data);
    
            const updatedOrderResponse = await axios.get(`${LARAVEL_BASE_URL}/api/v2/order-status/${orderId}`);
            const updatedOrder = updatedOrderResponse.data.order;
            logToFile(`Updated order details: ${JSON.stringify(updatedOrder)}`);
    
            const driver_token = updatedOrder.agora_token_driver;
            const token = data.order.agora_token_chat || updatedOrder.agora_token_chat;
    
            const rideAcceptedData = {
                status: 'success',
                message: 'Ride accepted successfully.',
                data: {
                    order: {
                        id: orderId,
                        status: 'driver_accepted',
                        driver: {
                            id: data.driver.id,
                            name: data.driver.name,
                            image_url: data.driver.image_url,
                            phone: data.driver.phone,
                            vehicle_type: data.driver.vehicle_type,
                            plate_number: data.driver.plate_number,
                            color: data.driver.color,
                            agora_username: data.driver.agora_username,
                        },
                        agora_token_chat: token,
                    },
                },
            };
    
            socket.emit('ride_accepted', rideAcceptedData);
            logToFile(`Emitted 'ride_accepted' event to driver ${socket.id}`);
    
            await forwardEventToLaravel(socket, 'ride_accepted', rideAcceptedData.data);
    
            let rideStatus;
            for (let i = 0; i < 5; i++) {
                rideStatus = await checkRideStatus(orderId);
                if (rideStatus === 'driver_accepted') break;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
    
            if (rideStatus !== 'driver_accepted') {
                logToFile(`Error: Ride status not confirmed for order ${orderId}.`);
                return;
            }
    
            // Fetch latest ride status to confirm it was updated
            const confirmedOrderResponse = await axios.get(`${LARAVEL_BASE_URL}/api/v2/order-status/${orderId}`);
            const confirmedOrder = confirmedOrderResponse.data.order;
            
            const confirmRideData = {
                status: 'success',
                message: 'Ride has been confirmed.',
                data: {
                    order: {
                        id: confirmedOrder.id,
                        status: confirmedOrder.status,
                        confirmed_at: confirmedOrder.confirmed_at,
                        agora_token_driver: driver_token,
                    },
                    driver: {
                        id: confirmedOrder.driver.id,
                    },
                },
            };
    
            io.to(socket.id).emit('confirm_ride', confirmRideData);
            logToFile(`Emitted 'confirm_ride' event with updated order status to driver socket ${socket.id}`);
    
            await forwardEventToLaravel(socket, 'confirm_ride', confirmRideData.data);
        } catch (error) {
            logToFile(`Error handling accept_order for socket ${socket.id}: ${error.message}`);
            socket.emit('ride_accepted', {
                status: 'error',
                message: 'Failed to accept the ride. Please try again.',
            });
        }
    },
    

    ride_accepted: async (socket, data) => {
        try {
            logToFile(`accept_order event triggered for socket ${socket.id} with data: ${JSON.stringify(data)}`);
    
            if (!data.order || !data.order.id) {
                logToFile(`Error: Invalid order data received. Data: ${JSON.stringify(data)}`);
                socket.emit('accept_order_response', {
                    status: 'error',
                    message: 'Invalid order data.',
                });
                return;
            }
    
            const orderId = data.order.id;
            logToFile(`Checking order ID: ${orderId}`);
    
            const orderResponse = await axios.get(`${LARAVEL_BASE_URL}/api/v2/order-status/${orderId}`);
            logToFile(`Order status response: ${JSON.stringify(orderResponse.data)}`);
    
            if (!orderResponse.data?.order?.status) {
                logToFile(`Error: Invalid order status received from backend.`);
                socket.emit('accept_order_response', {
                    status: 'error',
                    message: 'Invalid order status received.',
                });
                return;
            }
    
            if (orderResponse.data.order.status === 'driver_accepted') {
                logToFile(`Ride ${orderId} already accepted by another driver.`);
                socket.emit('ride_accepted', {
                    status: 'error',
                    message: 'This ride has already been accepted by another driver.',
                });
                return;
            }
    
            await forwardEventToLaravel(socket, 'accept_order', data);
    
            const updatedOrderResponse = await axios.get(`${LARAVEL_BASE_URL}/api/v2/order-status/${orderId}`);
            const updatedOrder = updatedOrderResponse.data.order;
            logToFile(`Updated order details: ${JSON.stringify(updatedOrder)}`);
    
            const driver_token = updatedOrder.agora_token_driver;
            const token = data.order.agora_token_chat || updatedOrder.agora_token_chat;
    
            const rideAcceptedData = {
                status: 'success',
                message: 'Ride accepted successfully.',
                data: {
                    order: {
                        id: orderId,
                        status: 'driver_accepted',
                        driver: {
                            id: data.driver.id,
                            name: data.driver.name,
                            image_url: data.driver.image_url,
                            phone: data.driver.phone,
                            vehicle_type: data.driver.vehicle_type,
                            plate_number: data.driver.plate_number,
                            color: data.driver.color,
                            agora_username: data.driver.agora_username,
                            agora_token_driver: driver_token
                        },
                        agora_token_chat: token,
                    },
                },
            };
    
            socket.emit('ride_accepted', rideAcceptedData);
            logToFile(`Emitted 'ride_accepted' event to driver ${socket.id}`);
    
            await forwardEventToLaravel(socket, 'ride_accepted', rideAcceptedData.data);
    
            // Wait until the ride status is confirmed before emitting 'confirm_ride'
            let rideStatus;
            for (let i = 0; i < 5; i++) { // Retry up to 5 times
                rideStatus = await checkRideStatus(orderId);
                if (rideStatus === 'driver_accepted') break;
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 sec
            }
    
            if (rideStatus !== 'driver_accepted') {
                logToFile(`Error: Ride status not confirmed for order ${orderId}.`);
                return;
            }
    
            const confirmRideData = {
                status: 'success',
                message: 'Ride has been confirmed.',
                data: {
                    order: {
                        id: orderId,
                        status: 'ride_confirmed',
                        driver: {
                            id: data.driver.id,
                            name: data.driver.name,
                            image_url: data.driver.image_url,
                            phone: data.driver.phone,
                            vehicle_type: data.driver.vehicle_type,
                            plate_number: data.driver.plate_number,
                            color: data.driver.color,
                            agora_username: data.driver.agora_username,
                            agora_token_driver: driver_token
                        },
                        agora_token_chat: token
                    },
                },
            };
    
            socket.emit('confirm_ride', confirmRideData);
            logToFile(`Emitted 'confirm_ride' event to driver ${socket.id}`);
    
            await forwardEventToLaravel(socket, 'confirm_ride', confirmRideData.data);
        } catch (error) {
            logToFile(`Error handling accept_order for socket ${socket.id}: ${error.message}`);
            socket.emit('ride_accepted', {
                status: 'error',
                message: 'Failed to accept the ride. Please try again.',
            });
        }
    },
    
    order_cancelled: async (socket, data) => {
        try {
            logToFile(`ride_cancelled event triggered with data: ${JSON.stringify(data)}`);
    
            if (!data.order_id || !data.user_id) {
                logToFile('Invalid data received for ride_cancelled event');
                return;
            }
    
            const { order_id, user_id, reason } = data;
    
            // Fetch order details from Laravel backend to determine user_type
            const orderResponse = await fetch(`${LARAVEL_API_URL}/orders/${order_id}`);
            const order = await orderResponse.json();
    
            if (!order || !order.customer || !order.driver) {
                logToFile(`Order not found or missing required fields for order ID: ${order_id}`);
                return;
            }
    
            let user_type = null;
            let targetSocketId = null;
    
            // Determine if the user is the rider or driver
            if (order.customer === user_id) {
                user_type = 'rider';
                targetSocketId = userConnectionStatus.get(order.driver)?.socketId;
            } else if (order.driver === user_id) {
                user_type = 'driver';
                targetSocketId = userConnectionStatus.get(order.customer)?.socketId;
            } else {
                logToFile(`User ID ${user_id} does not match customer or driver for order ID: ${order_id}`);
                return;
            }
    
            logToFile(`${user_type} is canceling ride order ${order_id}`);
    
            // Notify the other party via WebSocket
            if (targetSocketId) {
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) {
                    targetSocket.emit('ride_cancelled', {
                        status: 'cancelled',
                        order_id,
                        cancelled_by: user_type,
                        reason: reason || 'No reason provided'
                    });
    
                    logToFile(`Notified ${user_type === 'rider' ? 'driver' : 'rider'} about the cancellation.`);
                }
            }
    
            // Forward the cancellation event to Laravel backend
            await forwardEventToLaravel(socket, 'ride_cancelled', {
                order_id,
                cancelled_by: user_type,
                reason: reason || 'No reason provided'
            });
    
            logToFile(`Ride order ${order_id} has been cancelled and updated in Laravel backend.`);
    
        } catch (error) {
            logToFile(`Error in ride_cancelled handler: ${error.message}`);
        }
    },
    
    reject_order: async (socket, data) => {
        await forwardEventToLaravel(socket, 'reject_order', data);
    },
    cancel_order: async (socket, data) => {
        await forwardEventToLaravel(socket, 'cancel_order', data);

        socket.emit('cancel_order', {
            status: 'canceled',
            message: 'Ride Canceled.',
            data: data,
        });

        logToFile(`Emitted 'cancel_order' event for socket ${socket.id} with data: ${JSON.stringify(data)}`);

        try {
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'cancel_order',
                order: {
                    id: data.order.id,
                    status: 'canceled',
                    customer_note: data.order.customer_note,
                    driver_note: data.order.driver_note
                }
            });

            logToFile(`Trip canceled updated in backend: ${JSON.stringify(response.data)}`);
        } catch (error) {
            logToFile(`Error updating trip canceled status in backend: ${error.message}`);
        }
    },
    driver_enroute_to_rider: async (socket, data) => {
        await forwardEventToLaravel(socket, 'driver_enroute_to_rider', data);

        socket.emit('driver_enroute_to_rider', {
            status: 'success',
            message: 'Driver Enroute.',
            data: data,
        });

        logToFile(`Emitted 'driver_enroute_to_rider' event for socket ${socket.id} with data: ${JSON.stringify(data)}`);

        try {
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'driver_enroute_to_rider',
                rideId: data.order.id,
                driverId: data.driver.id,
                status: 'on_driver',
                position: {
                    longitude: data.driver.position.longitude,
                    latitude: data.driver.position.latitude,
                },
            });

            logToFile(`driver enroute updated in backend: ${JSON.stringify(response.data)}`);
        } catch (error) {
            logToFile(`Error updating drivers arrival status in backend: ${error.message}`);
        }
    },
    driver_arrived: async (socket, data) => {
        await forwardEventToLaravel(socket, 'driver_arrived', data);

        socket.emit('driver_arrived', {
            status: 'success',
            message: 'Driver has arrived.',
            data: data,
        });

        logToFile(`Emitted 'driver_arrived' event for socket ${socket.id} with data: ${JSON.stringify(data)}`);

        try {
            // Send data to Laravel backend
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'driver_arrived',
                rideId: data.order.id,
                status: 'arrived',
                driverId: data.driver.id
            });

            logToFile(`Driver arrival updated in backend: ${JSON.stringify(response.data)}`);
        } catch (error) {
            logToFile(`Error updating driver arrival in backend: ${error.message}`);
        
            // Log the stack trace for detailed debugging
            if (error.stack) {
                logToFile(`Error stack trace: ${error.stack}`);
            }

            // Optionally log the full error object for more insights
            logToFile(`Full error object: ${JSON.stringify(error)}`);
        }
    },
    driver_waiting: async (socket, data) => {
        await forwardEventToLaravel(socket, 'driver_waiting', data);
    },
    update_driver_location: async (socket, data) => {
        try {
            await forwardEventToLaravel(socket, 'update_driver_location', data);
    
            // Fix: Access driver_id inside data.data
            const driverId = data.data?.driver_id;
            if (!driverId) throw new Error("Driver ID is missing");
    
            // Send data to Laravel backend
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'update_driver_location',
                order_id: data.data?.order_id || null,  // Fix order_id
                driver_id: driverId,  
                latitude: data.data?.latitude,
                longitude: data.data?.longitude
            });
    
            logToFile(`Driver location updated in backend: ${JSON.stringify(response.data)}`);
    
            // Emit event only after a successful backend update
            socket.emit('update_driver_location', {
                status: 'success',
                message: 'Driver Location updated.',
                data: data,
            });
    
            logToFile(`Emitted 'update_driver_location' event for socket ${socket.id} with data: ${JSON.stringify(data)}`);
    
        } catch (error) {
            logToFile(`Error updating Driver location in backend: ${error.message}`);
    
            // Log the stack trace for detailed debugging
            if (error.stack) {
                logToFile(`Error stack trace: ${error.stack}`);
            }
    
            // Optionally log the full error object for more insights
            logToFile(`Full error object: ${JSON.stringify(error)}`);
    
            // Emit an error event to the driver
            socket.emit('update_driver_location', {
                status: 'error',
                message: 'Failed to update driver location.',
            });
        }
    },
       
    start_trip: async (socket, data) => {
        await forwardEventToLaravel(socket, 'start_trip', data);

        socket.emit('start_trip', {
            status: 'success',
            message: 'Trip has started.',
            data: data,
        });

        logToFile(`Emitted 'start_trip' event for socket ${socket.id} with data: ${JSON.stringify(data)}`);

        try {
            // Send data to Laravel backend
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'start_trip',
                order: {
                    id: order.data.id,
                    status: 'picked_up',
                    start_time: order.data.start_time,
                },
            });

            logToFile(`Trip started in backend: ${JSON.stringify(response.data)}`);
        } catch (error) {
            logToFile(`Error updating Trip status in backend: ${error.message}`);
        
            // Log the stack trace for detailed debugging
            if (error.stack) {
                logToFile(`Error stack trace: ${error.stack}`);
            }

            // Optionally log the full error object for more insights
            logToFile(`Full error object: ${JSON.stringify(error)}`);
        }
    },

    trip_in_progress: async (socket, data) => {
        await forwardEventToLaravel(socket, 'trip_in_progress', data);

        socket.emit('trip_in_progress', {
            status: 'success',
            message: 'Trip in progress.',
            data: data,
        });

        try {
            // Forward data to Laravel backend
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'trip_in_progress',
                order_id,
                driver_id,
                latitude,
                longitude,
            });
    
            // Emit success response back to the client
            socket.emit('trip_in_progress', {
                status: 'success',
                message: 'Trip status and location updated successfully.',
                data: response.data,
            });
    
            logToFile(`Trip in progress updated for order ${order_id}: ${JSON.stringify(response.data)}`);
        } catch (error) {
            logToFile(`Error in trip_in_progress event: ${error.message}`);
    
            // Emit error back to the client
            socket.emit('error', {
                status: 'error',
                message: 'Failed to update trip status and location.',
                error: error.message,
            });
        }
    },

    arrived_at_destination: async (socket, data) => {
        // Forward the event to Laravel
        await forwardEventToLaravel(socket, 'arrived_at_destination', data);
    
        // Emit the event to the client
        socket.emit('arrived_at_destination', {
            status: 'success',
            message: 'Driver has arrived at the destination.',
            data: data,
        });
    
        logToFile(`Emitted 'arrived_at_destination' event for socket ${socket.id} with data: ${JSON.stringify(data)}`);
    
        try {
            // Send data to Laravel backend
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'arrived_at_destination',
                rideId: data.order.id,
                status: 'delivered',
                driverId: data.driver.id,
            });
    
            logToFile(`Arrival at destination updated in backend: ${JSON.stringify(response.data)}`);
        } catch (error) {
            logToFile(`Error updating arrival at destination in backend: ${error.message}`);
    
            // Log the stack trace for detailed debugging
            if (error.stack) {
                logToFile(`Error stack trace: ${error.stack}`);
            }
    
            // Optionally log the full error object for more insights
            logToFile(`Full error object: ${JSON.stringify(error)}`);
        }
    }, 
    
    end_trip: async (socket, data) => {
        try {
            // Validate input data
            if (!data.order_id || !data.driver_id || !data.rider_id) {
                socket.emit('error', {
                    status: 'error',
                    message: 'Invalid request. Missing order_id, driver_id, or rider_id.',
                });
                return;
            }
    
            // Log the received data for debugging
            logToFile(`Received end_trip event: ${JSON.stringify(data)}`);
    
            // Forward event to Laravel before processing
            await forwardEventToLaravel(socket, 'end_trip', data);
    
            // Send acknowledgment to the emitter
            socket.emit('end_trip', {
                status: 'success',
                message: 'Trip has ended (pre-backend processing).',
                data: data,
            });
    
            // Ensure LARAVEL_BASE_URL is correctly defined
            if (!LARAVEL_BASE_URL) {
                throw new Error('LARAVEL_BASE_URL is not defined');
            }
    
            // Send trip completion data to Laravel API
            const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'end_trip',
                order_id: data.order_id,
                driver_id: data.driver_id,
                rider_id: data.rider_id,
                end_time: data.end_time,
                payment_mode: data.payment_mode,
                amount: data.amount,
            });
    
            logToFile(`Laravel response: ${JSON.stringify(response.data)}`);
    
            // Check if response is successful
            if (!response.data || response.status !== 200) {
                throw new Error('Failed to update trip status in backend.');
            }
    
            // Fetch the connected socket IDs
            const driverSocketId = userConnectionStatus.get(data.driver_id)?.socketId;
            const riderSocketId = userConnectionStatus.get(data.rider_id)?.socketId;
    
            logToFile(`Driver Socket ID: ${driverSocketId}, Rider Socket ID: ${riderSocketId}`);
    
            // Emit the event to the driver if connected
            if (driverSocketId && io.sockets.sockets.get(driverSocketId)) {
                io.to(driverSocketId).emit('end_trip', {
                    status: 'success',
                    message: 'Trip ended successfully.',
                    data: response.data,
                });
            } else {
                logToFile(`Driver ${data.driver_id} is not connected or socket ID is missing.`);
            }
    
            // Emit the event to the rider if connected
            if (riderSocketId && io.sockets.sockets.get(riderSocketId)) {
                io.to(riderSocketId).emit('end_trip', {
                    status: 'success',
                    message: 'Trip ended successfully.',
                    data: response.data,
                });
            } else {
                logToFile(`Rider ${data.rider_id} is not connected or socket ID is missing.`);
            }
    
            // Log successful update
            logToFile(`Trip status updated for order ${data.order_id}: ${JSON.stringify(response.data)}`);
        } catch (error) {
            // Log and emit errors
            logToFile(`Error in end_trip event: ${error.message}`);
    
            socket.emit('error', {
                status: 'error',
                message: 'Failed to end trip',
                error: error.message,
            });
        }
    },    

    // end_trip: async (socket, data) => {
    //     try {
    //         // Validate input data
    //         if (!data.order_id || !data.driver_id || !data.rider_id) {
    //             socket.emit('error', {
    //                 status: 'error',
    //                 message: 'Invalid request. Missing order_id, driver_id, or rider_id.',
    //             });
    //             return;
    //         }
    
    //         // Log the received data for debugging
    //         logToFile(`Received end_trip event: ${JSON.stringify(data)}`);
    
    //         // Forward event to Laravel before processing
    //         await forwardEventToLaravel(socket, 'end_trip', data);
    
    //         // Send acknowledgment to the emitter
    //         socket.emit('end_trip', {
    //             status: 'success',
    //             message: 'Trip has ended (pre-backend processing).',
    //             data: data,
    //         });
    
    //         // Ensure LARAVEL_BASE_URL is correctly defined
    //         if (!LARAVEL_BASE_URL) {
    //             throw new Error('LARAVEL_BASE_URL is not defined');
    //         }
    
    //         // Send trip completion data to Laravel API
    //         const response = await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
    //             event: 'end_trip',
    //             data: {
    //                 order: {
    //                     id: data.order_id,
    //                     status: 'completed',
    //                     end_time: data.end_time,
    //                     payment_mode: data.payment_mode,
    //                     amount: data.amount,
    //                 },
    //             },
    //         });
    
    //         // Check if response is successful
    //         if (!response.data || response.status !== 200) {
    //             throw new Error('Failed to update trip status in backend.');
    //         }
    
    //         // Fetch the connected socket IDs
    //         const driverSocketId = userConnectionStatus.get(data.driver_id)?.socketId;
    //         const riderSocketId = userConnectionStatus.get(data.rider_id)?.socketId;
    
    //         // Emit the event to the driver if connected
    //         if (driverSocketId) {
    //             socket.to(driverSocketId).emit('end_trip', {
    //                 status: 'success',
    //                 message: 'Trip ended successfully.',
    //                 data: response.data,
    //             });
    //         } else {
    //             logToFile(`Driver ${data.driver_id} is not connected.`);
    //         }
    
    //         // Emit the event to the rider if connected
    //         if (riderSocketId) {
    //             socket.to(riderSocketId).emit('end_trip', {
    //                 status: 'success',
    //                 message: 'Trip ended successfully.',
    //                 data: response.data,
    //             });
    //         } else {
    //             logToFile(`Rider ${data.rider_id} is not connected.`);
    //         }
    
    //         // Log successful update
    //         logToFile(`Trip status updated for order ${data.order_id}: ${JSON.stringify(response.data)}`);
    //     } catch (error) {
    //         // Log and emit errors
    //         logToFile(`Error in end_trip event: ${error.message}`);
    
    //         socket.emit('error', {
    //             status: 'error',
    //             message: 'Failed to end trip',
    //             error: error.message,
    //         });
    //     }
    // },        

    chat_message: async (socket, data) => {
        // Log the chat message for debugging
        logToFile(`Received 'chat_message' event from socket ${socket.id} with data: ${JSON.stringify(data)}`);
    
        // Broadcast the chat message to the intended room or all clients
        if (data.room) {
            // If the message is meant for a specific room, broadcast to that room
            io.to(data.room).emit('chat_message', {
                status: 'success',
                message: 'New chat message.',
                data: data,
            });
            logToFile(`Broadcasted 'chat_message' to room: ${data.room} with data: ${JSON.stringify(data)}`);
        } else {
            // Otherwise, broadcast to all connected clients
            io.emit('chat_message', {
                status: 'success',
                message: 'New chat message.',
                data: data,
            });
            logToFile(`Broadcasted 'chat_message' to all clients with data: ${JSON.stringify(data)}`);
        }
    
        // Optionally forward the event to Laravel for further processing
        await forwardEventToLaravel(socket, 'chat_message', data);
    }    
};

// Socket.IO event listeners
const userConnectionStatus = new Map();

io.on('connection', async (socket) => {
    logToFile(`A user connected: ${socket.id}`);

    socket.on('register_user', async (eventData) => {
        const userId = eventData?.userId;
        const fcmToken = eventData?.notify_token;

        console.log(`Logging user ${userId}`);
        logToFile(`Logging user ${userId}`);

        if (!userId) return;

        try {
            const userTypeResponse = await axios.get(`${LARAVEL_BASE_URL}/api/v2/user-type/${userId}`);
            const userType = userTypeResponse.data.userType;

            console.log(`Updating FCM Token for ${userType} ${userId}`);

            console.log(`Logging FCM Token ${fcmToken}`);

            if (fcmToken) {
                console.log(`Attempting to update FCM Token for ${userType} ${userId}`);
                console.log('Sending Data:', {
                    user_id: userId,
                    notify_token: fcmToken,
                });

                // console.log('Auth-token:', eventData.token);
            
                await axios.post(
                    `${LARAVEL_BASE_URL}/api/v2/store-fcm-token`,
                    { 
                        notify_token: fcmToken,
                        user_id: userId,
                    },
                );
            }

            // Get last active event
            // const response = await axios.get(
            //     `${LARAVEL_BASE_URL}/api/v2/last-event/${userId}`
            // );

            // const lastEvent = response.data;

            // // If there's an active trip event, re-emit it
            // if (lastEvent && lastEvent.event_type !== 'end_trip') {
            //     console.log(`Re-emitting last event ${lastEvent.event_type} for ${userType} ${userId}`);
            //     if (eventHandlers[lastEvent.event_type]) {
            //         await eventHandlers[lastEvent.event_type](socket, JSON.parse(lastEvent.event_data));
            //     }
            // }
            const response = await axios.get(
                `${LARAVEL_BASE_URL}/api/v2/last-event/${userId}`
            );
            
            const lastEvent = response.data;
            
            // Ensure event exists before emitting
            if (lastEvent && lastEvent.event_type && lastEvent.event_type !== 'end_trip') {
                console.log(`Re-emitting last event ${lastEvent.event_type} for ${userType} ${userId}`);
                
                if (eventHandlers[lastEvent.event_type]) {
                    await eventHandlers[lastEvent.event_type](socket, JSON.parse(lastEvent.event_data));
                }
            }            

            // Handle the current event data if it's a location update
            if (eventData.data?.event === 'update_driver_location') {
                socket.emit('driver_location_update', {
                    driver_id: userId,
                    latitude: eventData.data.latitude,
                    longitude: eventData.data.longitude
                });
            }

            // Update connection status
            userConnectionStatus.set(userId, {
                socketId: socket.id,
                status: 'online',
                userType,
                lastSeen: new Date(),
            });

            // Notify backend about connection status change
            await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                event: 'update_connection_status',
                data: {
                    userId: userId,
                    userType: userType,
                    event_type: 'connection_status_change',
                    event_data: JSON.stringify({
                        status: 'online',
                        timestamp: new Date().toISOString(),
                    }),
                    user_connection_status: 'online',
                    driver_connection_status: userType === 'driver' ? 'online' : null,
                },
            });

            console.log(`User ${userId} (${userType}) connected`);
        } catch (error) {
            console.error(`Error handling user registration: ${error.message}`);
        }
    });  

    socket.on('join_room', (room) => {
        socket.join(room);
        roomAssignments[socket.id] = room;
        logToFile(`Socket ${socket.id} joined room: ${room}`);
    });

    socket.on('leave_room', (room) => {
        socket.leave(room);
        delete roomAssignments[socket.id];
        logToFile(`Socket ${socket.id} left room: ${room}`);
    });

    Object.keys(eventHandlers).forEach((event) => {
        socket.on(event, async (data) => {
            logToFile(`Predefined event received: ${event} | Data: ${JSON.stringify(data)}`);
            await eventHandlers[event](socket, data);
        });
    });

    socket.onAny(async (event, data) => {
        if (!eventHandlers[event]) {
            logToFile(`Dynamic event received: ${event} | Data: ${JSON.stringify(data)}`);
            await forwardEventToLaravel(socket, event, data);
        }
    });

    socket.on('disconnect', async () => {
        // Find user by socket ID
        for (const [userId, data] of userConnectionStatus.entries()) {
            if (data.socketId === socket.id) {
                userConnectionStatus.set(userId, {
                    ...data,
                    status: 'offline',
                    lastSeen: new Date()
                });

                try {
                    await axios.post(`${LARAVEL_BASE_URL}/api/v2/event`, {
                        event: 'update_connection_status',
                        data: {
                            userId: userId,
                            userType: data.userType,
                            event_type: 'connection_status_change',
                            event_data: JSON.stringify({
                                status: 'offline',
                                timestamp: new Date().toISOString(),
                            }),
                            user_connection_status: 'offline',
                            driver_connection_status: data.userType === 'driver' ? 'offline' : null,
                        },
                    });

                    console.log(`User ${userId} (${data.userType}) disconnected`);
                } catch (error) {
                    console.error(`Error updating disconnect status: ${error.message}`);
                }
                break;
            }
        }
    });   
});

// Fetch logs
app.get('/logs', (req, res) => {
    fs.readFile(LOG_FILE_PATH, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Error reading log file.');
        }

        try {
            const parsedData = JSON.parse(data);

            const formattedData = JSON.stringify(parsedData, null, 2);

            res.send(`<pre style="white-space: pre-wrap; word-wrap: break-word;">${formattedData}</pre>`);

        } catch (e) {
            res.send(`<pre style="white-space: pre-wrap; word-wrap: break-word;">${data}</pre>`);
        }
    });
});

app.get("/", (req, res) => {
    res.send("Socket.IO Server is Running");
});

// Start the server
// const PORT = process.env.PORT || 3322;
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    logToFile(`Server running on http://localhost:${PORT}`);
    console.log(`Server running on http://localhost:${PORT}`);
});