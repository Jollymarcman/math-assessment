# Stick Fight WSS server

This is a small, single-process room server intended for the first private multiplayer prototype. Render can run it as a Node web service in Singapore. It exposes a health check at `/health` and a secure WebSocket endpoint at `/ws` (`wss://<service-host>/ws`).

## Render settings

- Root directory: `StickFightWeb/server`
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Region: Singapore
- Instance count: one

The free instance can sleep after 15 minutes without inbound traffic, so the first connection after idle can take about a minute. Rooms and their state exist only in memory and are lost on restart or redeploy. Keep the service to one instance: the first version does not share room state across instances.

## Wire protocol (initial prototype)

The server sends JSON messages. Clients send one of:

- `{"type":"list"}` to list rooms.
- `{"type":"create","name":"Player"}` to create a room.
- `{"type":"join","code":"ABC234","name":"Player"}` to join by code.
- `{"type":"leave"}` to leave a room.
- `{"type":"start"}` for the host to start once at least two players are present.

After joining, binary WebSocket messages are relayed unchanged to every other player in that room. This is only the transport and room scaffold. The Unity WebGL client still needs a browser WebSocket bridge and an adapter that connects this relay to Stick Fight's existing packet handlers; the server alone does not yet make in-game multiplayer playable.