// Global variables
let activeSessions = [];
let stats = { totalShares: 0, successRate: 0 };
let ws;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000;
const POLL_INTERVAL = 5000;

// Initialize WebSocket connection
function initWebSocket() {
    ws = new WebSocket(`wss://${window.location.host}`);
    
    ws.onopen = () => {
        console.log('Connected to WebSocket server');
        reconnectAttempts = 0;
        fetchInitialData(); // Get fresh data on connection
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'sessions_update') {
            activeSessions = data.data.activeSessions;
            stats = data.data.stats;
            
            // Save to localStorage
            localStorage.setItem('fshare_sessions', JSON.stringify({
                activeSessions,
                stats
            }));
            
            updateSessionsUI();
            updateStatsUI();
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(initWebSocket, RECONNECT_DELAY);
        } else {
            console.log('Max reconnection attempts reached, falling back to polling');
            startPolling();
        }
    };
}
