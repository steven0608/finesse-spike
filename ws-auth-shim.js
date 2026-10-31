// Must load before Strophe.js, which captures window.WebSocket at load time and always
// opens sockets with the single subprotocol "xmpp".
// The Cisco Reverse Proxy (VPN-less Finesse) authenticates the notification WebSocket from the
// Sec-WebSocket-Protocol header: "xmpp, <URL-encoded Basic credentials>". When the Finesse client
// sets window.__finesseWsAuth, this shim appends it to the subprotocol list.
(function () {
  const Native = window.WebSocket;
  function FinesseWebSocket(url, protocols) {
    const auth = window.__finesseWsAuth;
    if (auth && protocols === 'xmpp') protocols = ['xmpp', auth];
    return protocols === undefined ? new Native(url) : new Native(url, protocols);
  }
  FinesseWebSocket.prototype = Native.prototype;
  Object.assign(FinesseWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = FinesseWebSocket;
})();
