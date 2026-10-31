// Finesse client core: REST commands + XMPP notifications.
// Transport-agnostic so it can be reused later by the Salesforce Voice (BYOT) connector.
// Requires the Strophe.js UMD build to be loaded first (window.strophe).

const NS_PUBSUB_EVENT = 'http://jabber.org/protocol/pubsub#event';

export const REST_PORT = 8445;
export const XMPP_PORT = 7443;

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function text(el, selector) {
  const node = el && el.querySelector(selector);
  return node ? node.textContent.trim() : '';
}

function childText(el, tag) {
  if (!el) return '';
  for (const child of el.children) {
    if (child.localName === tag) return child.textContent.trim();
  }
  return '';
}

export function parseXml(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Unparseable XML from Finesse');
  return doc;
}

export function parseUser(userEl) {
  if (!userEl) return null;
  return {
    loginId: childText(userEl, 'loginId'),
    loginName: childText(userEl, 'loginName'),
    firstName: childText(userEl, 'firstName'),
    lastName: childText(userEl, 'lastName'),
    extension: childText(userEl, 'extension'),
    state: childText(userEl, 'state'),
    pendingState: childText(userEl, 'pendingState'),
    stateChangeTime: childText(userEl, 'stateChangeTime'),
    reasonCode: text(userEl, 'reasonCode > label'),
    reasonCodeId: childText(userEl, 'reasonCodeId'),
    teamName: childText(userEl, 'teamName'),
    roles: [...userEl.querySelectorAll('roles > role')].map((r) => r.textContent.trim()),
  };
}

export function parseDialog(dialogEl) {
  if (!dialogEl) return null;
  const media = dialogEl.querySelector('mediaProperties');
  return {
    id: childText(dialogEl, 'id'),
    state: childText(dialogEl, 'state'),
    fromAddress: childText(dialogEl, 'fromAddress'),
    toAddress: childText(dialogEl, 'toAddress'),
    callType: text(media, 'callType'),
    dnis: text(media, 'DNIS'),
    dialedNumber: text(media, 'dialedNumber'),
    callVariables: media
      ? [...media.querySelectorAll('callvariables > CallVariable, callvariables > callVariable')].map((cv) => ({
          name: childText(cv, 'name'),
          value: childText(cv, 'value'),
        }))
      : [],
    participants: [...dialogEl.querySelectorAll('participants > Participant')].map((p) => ({
      mediaAddress: childText(p, 'mediaAddress'),
      state: childText(p, 'state'),
      actions: [...p.querySelectorAll('actions > action')].map((a) => a.textContent.trim()),
    })),
  };
}

export class FinesseClient extends EventTarget {
  /**
   * @param {object} cfg
   * @param {string} cfg.host        Finesse FQDN (also the XMPP domain unless cfg.xmppDomain is set)
   * @param {string} cfg.agentId     Agent ID (Finesse user id)
   * @param {string} [cfg.authId]    Id used for Basic auth (defaults to agentId; PCCE also accepts the login name)
   * @param {string} cfg.password
   * @param {string} cfg.extension
   * @param {'direct'|'proxy'} [cfg.mode]  direct = browser calls Finesse (tests CORS); proxy = via local server
   * @param {'bosh'|'websocket'} [cfg.transport]
   * @param {string} [cfg.xmppDomain]
   * @param {number} [cfg.restPort]
   * @param {number} [cfg.xmppPort]
   * @param {boolean} [cfg.reverseProxy]  Cisco Reverse Proxy (VPN-less): WebSocket only, credentials in subprotocol
   */
  constructor(cfg) {
    super();
    this.cfg = { mode: 'direct', transport: 'bosh', ...cfg };
    this.cfg.authId = this.cfg.authId || this.cfg.agentId;
    this.cfg.restPort = Number(this.cfg.restPort) || REST_PORT;
    this.cfg.xmppPort = Number(this.cfg.xmppPort) || XMPP_PORT;
    if (this.cfg.reverseProxy) this.cfg.transport = 'websocket';
    this.xmpp = null;
    this.user = null;
    this.dialogs = new Map();
  }

  // ---- URLs ---------------------------------------------------------------

  get basicAuth() {
    return 'Basic ' + btoa(`${this.cfg.authId}:${this.cfg.password}`);
  }

  get restBase() {
    const { mode, host, restPort } = this.cfg;
    return mode === 'proxy' ? `/proxy/${host}:${restPort}/rest` : `https://${host}:${restPort}`;
  }

  get xmppUrl() {
    const { mode, host, transport, xmppPort } = this.cfg;
    if (mode === 'proxy') return `/proxy/${host}:${xmppPort}/bosh`;
    return transport === 'websocket' ? `wss://${host}:${xmppPort}/ws/` : `https://${host}:${xmppPort}/http-bind/`;
  }

  // ---- Events -------------------------------------------------------------

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  log(level, message, data) {
    this.emit('log', { level, message, data, at: new Date() });
  }

  // ---- REST ---------------------------------------------------------------

  async request(method, path, body) {
    const url = this.restBase + path;
    const headers = {
      Authorization: this.basicAuth,
      Accept: 'application/xml',
    };
    if (body) headers['Content-Type'] = 'application/xml';
    this.log('req', `${method} ${path}`, body);

    let res;
    try {
      res = await fetch(url, { method, headers, body, mode: 'cors', cache: 'no-store' });
    } catch (err) {
      const hint =
        this.cfg.mode === 'direct'
          ? 'Browser blocked the request. Usual causes: this page origin is not in the Finesse CORS allow-list, ' +
            `the Finesse certificate is not trusted (open https://${this.cfg.host}:${this.cfg.restPort}/finesse once and accept it), ` +
            'or the host is unreachable (VPN?).'
          : 'Local proxy unreachable. Is `npm start` still running?';
      const portHint = ` (port ${this.cfg.restPort})`;
      if (this.cfg.mode === 'direct') err.message += portHint;
      this.log('error', `${method} ${path} failed: ${err.message}`, hint);
      const e = new Error(`${err.message}. ${hint}`);
      e.kind = 'network';
      throw e;
    }

    const textBody = await res.text();
    this.log(res.ok ? 'res' : 'error', `${res.status} ${res.statusText} ← ${method} ${path}`, textBody);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const doc = parseXml(textBody);
        const apiMsg = text(doc, 'ErrorMessage') || text(doc, 'errorMessage') || text(doc, 'ErrorType');
        if (apiMsg) msg += `: ${apiMsg}`;
      } catch {
        /* non-XML error body (e.g. proxy error) */
        if (textBody) msg += `: ${textBody.slice(0, 200)}`;
      }
      const e = new Error(msg);
      e.kind = 'http';
      e.status = res.status;
      throw e;
    }
    return { status: res.status, body: textBody, doc: textBody ? parseXml(textBody) : null };
  }

  async getSystemInfo() {
    const { doc } = await this.request('GET', '/finesse/api/SystemInfo');
    const info = {
      status: text(doc, 'SystemInfo > status'),
      deploymentType: text(doc, 'deploymentType'),
      xmppDomain: text(doc, 'xmppDomain'),
      pubsubDomain: text(doc, 'xmppPubSubDomain'),
      currentTimestamp: text(doc, 'currentTimestamp'),
      primaryNode: text(doc, 'primaryNode > host'),
      secondaryNode: text(doc, 'secondaryNode > host'),
      peripheralId: text(doc, 'peripheralId'),
    };
    if (info.xmppDomain && !this.cfg.xmppDomain) this.cfg.xmppDomain = info.xmppDomain;
    return info;
  }

  async getUser() {
    const { doc } = await this.request('GET', `/finesse/api/User/${encodeURIComponent(this.cfg.agentId)}`);
    this.user = parseUser(doc.querySelector('User'));
    this.emit('user', this.user);
    return this.user;
  }

  userPut(xmlInner) {
    return this.request('PUT', `/finesse/api/User/${encodeURIComponent(this.cfg.agentId)}`, `<User>${xmlInner}</User>`);
  }

  login() {
    return this.userPut(`<state>LOGIN</state><extension>${escapeXml(this.cfg.extension)}</extension>`);
  }

  setState(state, reasonCodeId) {
    const reason = reasonCodeId ? `<reasonCodeId>${escapeXml(reasonCodeId)}</reasonCodeId>` : '';
    return this.userPut(`<state>${escapeXml(state)}</state>${reason}`);
  }

  logout(reasonCodeId) {
    return this.setState('LOGOUT', reasonCodeId);
  }

  async getReasonCodes(category) {
    const { doc } = await this.request(
      'GET',
      `/finesse/api/User/${encodeURIComponent(this.cfg.agentId)}/ReasonCodes?category=${encodeURIComponent(category)}`
    );
    return [...doc.querySelectorAll('ReasonCode')].map((rc) => ({
      id: childText(rc, 'uri').split('/').pop(),
      label: childText(rc, 'label'),
      code: childText(rc, 'code'),
    }));
  }

  async getDialogs() {
    const { doc } = await this.request('GET', `/finesse/api/User/${encodeURIComponent(this.cfg.agentId)}/Dialogs`);
    this.dialogs.clear();
    for (const el of doc.querySelectorAll('Dialogs > Dialog')) {
      const d = parseDialog(el);
      this.dialogs.set(d.id, d);
    }
    this.emit('dialogs', [...this.dialogs.values()]);
    return [...this.dialogs.values()];
  }

  makeCall(toAddress) {
    return this.request(
      'POST',
      `/finesse/api/User/${encodeURIComponent(this.cfg.agentId)}/Dialogs`,
      `<Dialog><requestedAction>MAKE_CALL</requestedAction>` +
        `<fromAddress>${escapeXml(this.cfg.extension)}</fromAddress>` +
        `<toAddress>${escapeXml(toAddress)}</toAddress></Dialog>`
    );
  }

  /** action: ANSWER | HOLD | RETRIEVE | DROP | ... */
  dialogAction(dialogId, action) {
    return this.request(
      'PUT',
      `/finesse/api/Dialog/${encodeURIComponent(dialogId)}`,
      `<Dialog><targetMediaAddress>${escapeXml(this.cfg.extension)}</targetMediaAddress>` +
        `<requestedAction>${escapeXml(action)}</requestedAction></Dialog>`
    );
  }

  sendDtmf(dialogId, digits) {
    return this.request(
      'PUT',
      `/finesse/api/Dialog/${encodeURIComponent(dialogId)}`,
      `<Dialog><targetMediaAddress>${escapeXml(this.cfg.extension)}</targetMediaAddress>` +
        `<requestedAction>SEND_DTMF</requestedAction><actionParams><ActionParam>` +
        `<name>dtmfString</name><value>${escapeXml(digits)}</value></ActionParam></actionParams></Dialog>`
    );
  }

  // ---- XMPP notifications --------------------------------------------------

  /** Resolves once connected; rejects on auth/connection failure. */
  connectEvents() {
    const lib = globalThis.strophe;
    if (!lib) return Promise.reject(new Error('Strophe.js not loaded'));
    const { Strophe, $pres } = lib;
    const domain = this.cfg.xmppDomain || this.cfg.host;
    const jid = `${this.cfg.agentId}@${domain}/sfspike${Math.floor(Math.random() * 1e6)}`;

    this.disconnectEvents();
    // Read by ws-auth-shim.js when Strophe opens the socket.
    globalThis.__finesseWsAuth = this.cfg.reverseProxy ? encodeURIComponent(this.basicAuth) : null;
    const conn = new Strophe.Connection(this.xmppUrl);
    this.xmpp = conn;
    conn.rawInput = (data) => this.emit('xmpp-raw', { dir: 'in', data });
    conn.rawOutput = (data) => this.emit('xmpp-raw', { dir: 'out', data });

    const names = Object.fromEntries(Object.entries(Strophe.Status).map(([k, v]) => [v, k]));
    this.log('info', `XMPP connecting to ${this.xmppUrl} as ${jid}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      conn.connect(jid, this.cfg.password, (status, condition) => {
        const name = names[status] || String(status);
        this.emit('xmpp-status', { status: name, condition });
        this.log(status === Strophe.Status.CONNECTED ? 'res' : 'info', `XMPP ${name}${condition ? ` (${condition})` : ''}`);

        if (status === Strophe.Status.CONNECTED) {
          conn.addHandler((msg) => this.onXmppMessage(msg), null, 'message');
          conn.send($pres().tree());
          settled = true;
          resolve();
        } else if (
          !settled &&
          [Strophe.Status.AUTHFAIL, Strophe.Status.CONNFAIL, Strophe.Status.ERROR, Strophe.Status.DISCONNECTED].includes(status)
        ) {
          settled = true;
          const hint =
            status === Strophe.Status.AUTHFAIL
              ? 'XMPP authentication failed: check Agent ID / password and XMPP domain.'
              : 'XMPP connection failed: check port 7443 reachability, certificate trust and CORS for the event channel.';
          reject(new Error(`${name}${condition ? ` (${condition})` : ''}. ${hint}`));
        }
      });
    });
  }

  disconnectEvents() {
    if (this.xmpp) {
      try {
        this.xmpp.disconnect('spike closed');
      } catch {
        /* already gone */
      }
      this.xmpp = null;
    }
  }

  onXmppMessage(msg) {
    try {
      const items = [...msg.getElementsByTagNameNS(NS_PUBSUB_EVENT, 'items')];
      for (const itemsEl of items) {
        const node = itemsEl.getAttribute('node');
        for (const notif of itemsEl.getElementsByTagName('notification')) {
          // Finesse sends the Update document as escaped text inside <notification>.
          const raw = notif.textContent.trim();
          if (raw) this.handleUpdate(node, raw);
        }
      }
    } catch (err) {
      this.log('error', `Failed to handle XMPP message: ${err.message}`);
    }
    return true; // keep handler registered
  }

  handleUpdate(node, raw) {
    const doc = parseXml(raw);
    const update = {
      node,
      event: text(doc, 'Update > event'),
      requestId: text(doc, 'Update > requestId'),
      source: text(doc, 'Update > source'),
      raw,
    };
    this.emit('notification', update);

    const data = doc.querySelector('Update > data');
    if (!data) return;

    const apiErrors = data.querySelector('apiErrors');
    if (apiErrors) {
      const msg = [...apiErrors.querySelectorAll('apiError')]
        .map((e) => `${text(e, 'errorType')}: ${text(e, 'errorMessage')}`)
        .join('; ');
      this.log('error', `Finesse rejected request ${update.requestId || ''}: ${msg}`);
      this.emit('api-error', { ...update, message: msg });
      return;
    }

    const userEl = data.querySelector('user, User');
    if (userEl) {
      this.user = parseUser(userEl);
      this.emit('user', this.user);
    }

    const dialogEls = data.querySelectorAll('dialog, Dialog');
    if (dialogEls.length) {
      for (const el of dialogEls) {
        const d = parseDialog(el);
        if (update.event === 'DELETE' || d.state === 'DROPPED') this.dialogs.delete(d.id);
        else this.dialogs.set(d.id, d);
        this.emit('dialog', { event: update.event, dialog: d });
      }
      this.emit('dialogs', [...this.dialogs.values()]);
    }
  }
}
