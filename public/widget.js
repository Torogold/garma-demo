(function () {
  const SERVER = ''; // En producción: 'https://garma-demo-production.up.railway.app'
  const SESSION_ID = 'w-' + Math.random().toString(36).slice(2, 9);

  const styles = `
    #gm-widget-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 9998;
      width: 60px; height: 60px; border-radius: 50%;
      background: linear-gradient(135deg, #1a3a5c, #2d6aa0);
      border: none; cursor: pointer;
      box-shadow: 0 4px 20px rgba(45,106,160,0.5);
      font-size: 26px; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s;
    }
    #gm-widget-btn:hover { transform: scale(1.1); }
    #gm-widget-box {
      position: fixed; bottom: 96px; right: 24px; z-index: 9999;
      width: 360px; height: 520px; border-radius: 16px; overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      display: none; flex-direction: column;
      font-family: -apple-system, 'Segoe UI', sans-serif;
    }
    #gm-widget-box.open { display: flex; }
    #gm-header {
      background: linear-gradient(135deg, #1a3a5c, #2d6aa0);
      color: white; padding: 14px 16px; display: flex; align-items: center; gap: 10px;
    }
    #gm-header-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,0.25);
      display: flex; align-items: center; justify-content: center; font-size: 18px;
    }
    #gm-header-name { font-weight: 700; font-size: 15px; }
    #gm-header-sub { font-size: 11px; opacity: 0.85; }
    #gm-header-close { margin-left: auto; background: none; border: none; color: white; font-size: 22px; cursor: pointer; line-height: 1; }
    #gm-messages {
      flex: 1; overflow-y: auto; padding: 14px 12px;
      background: #ece5dd; display: flex; flex-direction: column; gap: 8px;
    }
    .gm-msg { max-width: 80%; padding: 9px 13px; border-radius: 12px; font-size: 14px; line-height: 1.45; animation: gmFade 0.2s ease; }
    @keyframes gmFade { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
    .gm-msg.in { background: white; color: #1a1a1a; align-self: flex-start; border-bottom-left-radius: 3px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .gm-msg.out { background: #c8dff0; color: #1a1a1a; align-self: flex-end; border-bottom-right-radius: 3px; }
    .gm-badge { background: #e8f5e9; color: #2e7d32; border-radius: 10px; padding: 8px 12px; font-size: 13px; text-align: center; align-self: center; }
    #gm-typing { align-self: flex-start; background: white; padding: 10px 14px; border-radius: 12px; display: none; }
    #gm-typing span { display: inline-block; width: 7px; height: 7px; background: #2d6aa0; border-radius: 50%; margin: 0 2px; animation: gmBounce 1.2s infinite; }
    #gm-typing span:nth-child(2) { animation-delay: 0.15s; }
    #gm-typing span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes gmBounce { 0%,60%,100%{transform:translateY(0);} 30%{transform:translateY(-5px);} }
    #gm-input-area { background: white; padding: 10px 12px; display: flex; gap: 8px; border-top: 1px solid #d0e4f0; }
    #gm-input { flex: 1; border: 1px solid #c0d8ee; border-radius: 24px; padding: 8px 14px; font-size: 14px; outline: none; font-family: inherit; color: #1a1a1a; }
    #gm-input:focus { border-color: #2d6aa0; }
    #gm-send { width: 38px; height: 38px; border-radius: 50%; background: linear-gradient(135deg, #1a3a5c, #2d6aa0); border: none; cursor: pointer; color: white; font-size: 16px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = styles;
  document.head.appendChild(styleEl);

  document.body.insertAdjacentHTML('beforeend', `
    <button id="gm-widget-btn" title="Consultar o reservar">🚗</button>
    <div id="gm-widget-box">
      <div id="gm-header">
        <div id="gm-header-avatar">🚗</div>
        <div>
          <div id="gm-header-name">Garma Automoción</div>
          <div id="gm-header-sub">Alquiler · Venta · Taller · en línea</div>
        </div>
        <button id="gm-header-close">×</button>
      </div>
      <div id="gm-messages">
        <div id="gm-typing"><span></span><span></span><span></span></div>
      </div>
      <div id="gm-input-area">
        <input id="gm-input" type="text" placeholder="Escribe tu consulta..." />
        <button id="gm-send">➤</button>
      </div>
    </div>
  `);

  const btn = document.getElementById('gm-widget-btn');
  const box = document.getElementById('gm-widget-box');
  const msgs = document.getElementById('gm-messages');
  const typing = document.getElementById('gm-typing');
  const input = document.getElementById('gm-input');
  let opened = false;

  btn.addEventListener('click', () => { box.classList.toggle('open'); if (!opened) { opened = true; saludar(); } });
  document.getElementById('gm-header-close').addEventListener('click', () => box.classList.remove('open'));
  document.getElementById('gm-send').addEventListener('click', enviar);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') enviar(); });

  function addMsg(text, tipo) {
    const div = document.createElement('div');
    div.className = `gm-msg ${tipo}`;
    div.innerHTML = text;
    msgs.insertBefore(div, typing);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function showTyping(v) { typing.style.display = v ? 'block' : 'none'; msgs.scrollTop = msgs.scrollHeight; }

  async function saludar() {
    showTyping(true);
    await new Promise(r => setTimeout(r, 1000));
    showTyping(false);
    addMsg('¡Hola! 👋 Soy el asistente de <strong>Garma Automoción</strong>. Puedo ayudarte con alquiler de vehículos, consultas sobre venta, taller o renting. ¿En qué te puedo ayudar?', 'in');
  }

  async function enviar() {
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    addMsg(msg, 'out');
    showTyping(true);
    try {
      const res = await fetch(`${SERVER}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION_ID, mensaje: msg }),
      });
      const data = await res.json();
      showTyping(false);
      addMsg(data.respuesta, 'in');
      if (data.reservaCreada) {
        const r = data.reservaCreada;
        const badge = document.createElement('div');
        badge.className = 'gm-badge';
        badge.innerHTML = `✅ Reserva confirmada · ${r.vehiculo} · ${r.fecha_inicio} → ${r.fecha_fin}`;
        msgs.insertBefore(badge, typing);
        msgs.scrollTop = msgs.scrollHeight;
      }
    } catch {
      showTyping(false);
      addMsg('Ha ocurrido un error. Llámanos al <a href="tel:637558533">637 55 85 33</a>', 'in');
    }
  }
})();
