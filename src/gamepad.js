/**
 * Gamepad: XInput-style support via the Web Gamepad API.
 *
 * Exports:
 *   - initGamepad()        wires connect/disconnect listeners. Call once at boot.
 *   - pollGamepad()        sample the active pad. Call once per frame BEFORE input.
 *   - gamepadState         live snapshot { lx, ly, rx, ry, buttons{...}, connected, name }
 *
 * Notes:
 *   - Sticks use radial deadzone meta.optControllerDeadzone (default 0.18) with
 *     smooth rescale; triggers use a fixed 0.05.
 *   - Buttons expose .pressed (held) and .justPressed (this frame edge).
 *   - Right stick aims (top-down: x→x, y→z). Left stick moves.
 *   - First connected pad wins. Disconnect falls back to the next available.
 */

import { getMeta } from './meta.js';

// Iter 10a: stick deadzone is now configurable via meta.optControllerDeadzone
// (0.0..0.30 surfaced in Options ▸ Controls). Trigger threshold stays hard-
// coded — players don't usually customise it and it's already permissive.
const STICK_DEAD_DEFAULT = 0.18;
const TRIGGER_DEAD = 0.05;

function _stickDead() {
  try {
    const v = Number(getMeta().optControllerDeadzone);
    if (Number.isFinite(v) && v >= 0 && v <= 0.5) return v;
  } catch (_) {}
  return STICK_DEAD_DEFAULT;
}

// Standard XInput button indices (Gamepad API "standard" mapping).
const BTN = {
  a: 0, b: 1, x: 2, y: 3,
  lb: 4, rb: 5,
  lt: 6, rt: 7,
  back: 8, start: 9,
  // 10 = LS click, 11 = RS click (not exposed by name, but accessible via raw)
  dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15,
};

function makeButtonState() {
  return {
    a: false, b: false, x: false, y: false,
    lb: false, rb: false,
    lt: 0, rt: 0,
    start: false, back: false,
    dpadUp: false, dpadDown: false, dpadLeft: false, dpadRight: false,
  };
}

// Public live state. Consumers may read fields any time, but values are only
// guaranteed fresh immediately after pollGamepad().
export const gamepadState = {
  lx: 0, ly: 0,
  rx: 0, ry: 0,
  buttons: makeButtonState(),
  // Edge-trigger map: true only on the frame the button transitioned to pressed.
  justPressed: makeButtonState(),
  connected: false,
  name: '',
  index: -1,
};

// Previous-frame button bits, used to derive justPressed edges.
const _prev = makeButtonState();
let _initialized = false;

/** Apply radial deadzone + smooth rescale so output starts at 0 just past the dead band. */
function _deadzoneStick(x, y) {
  const dead = _stickDead();
  const mag = Math.hypot(x, y);
  if (mag < dead) return [0, 0];
  // Rescale [dead..1] → [0..1] so motion past the deadzone is smooth.
  const scaled = (mag - dead) / (1 - dead);
  const clamped = Math.min(1, scaled);
  const nx = (x / mag) * clamped;
  const ny = (y / mag) * clamped;
  return [nx, ny];
}

function _deadzoneTrigger(v) {
  if (v < TRIGGER_DEAD) return 0;
  return Math.min(1, (v - TRIGGER_DEAD) / (1 - TRIGGER_DEAD));
}

function _pickActivePad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected) return p;
  }
  return null;
}

export function initGamepad() {
  if (_initialized) return;
  _initialized = true;
  if (typeof window === 'undefined') return;

  window.addEventListener('gamepadconnected', (e) => {
    const gp = e.gamepad;
    // Adopt only if we don't already have one wired up.
    if (!gamepadState.connected) {
      gamepadState.connected = true;
      gamepadState.name = gp.id || '';
      gamepadState.index = gp.index;
      console.log(`[gamepad] connected: ${gp.id} (index ${gp.index}, mapping=${gp.mapping})`);
    }
  });

  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad && e.gamepad.index === gamepadState.index) {
      gamepadState.connected = false;
      gamepadState.name = '';
      gamepadState.index = -1;
      gamepadState.lx = gamepadState.ly = gamepadState.rx = gamepadState.ry = 0;
      const b = gamepadState.buttons; const j = gamepadState.justPressed;
      for (const k in b) { b[k] = (typeof b[k] === 'number') ? 0 : false; }
      for (const k in j) { j[k] = (typeof j[k] === 'number') ? 0 : false; }
      console.log(`[gamepad] disconnected: ${e.gamepad.id}`);
    }
  });
}

export function pollGamepad() {
  // Clear justPressed edges every frame regardless of pad presence.
  const j = gamepadState.justPressed;
  for (const k in j) { j[k] = (typeof j[k] === 'number') ? 0 : false; }

  const pad = _pickActivePad();
  if (!pad) {
    if (gamepadState.connected) {
      gamepadState.connected = false;
      gamepadState.name = '';
      gamepadState.index = -1;
    }
    return;
  }

  // (Re)latch identity if Chrome reports a pad without firing connect.
  if (!gamepadState.connected) {
    gamepadState.connected = true;
    gamepadState.name = pad.id || '';
    gamepadState.index = pad.index;
  }

  const axes = pad.axes || [];
  const [lx, ly] = _deadzoneStick(axes[0] || 0, axes[1] || 0);
  const [rx, ry] = _deadzoneStick(axes[2] || 0, axes[3] || 0);
  gamepadState.lx = lx; gamepadState.ly = ly;
  gamepadState.rx = rx; gamepadState.ry = ry;

  const buttons = pad.buttons || [];
  const b = gamepadState.buttons;

  // Helpers
  const readDigital = (idx) => !!(buttons[idx] && buttons[idx].pressed);
  const readAnalog = (idx) => {
    const btn = buttons[idx];
    if (!btn) return 0;
    // .value is 0..1 for analog (triggers); fallback to digital pressed state.
    return typeof btn.value === 'number' ? btn.value : (btn.pressed ? 1 : 0);
  };

  // Sample current state.
  const cur = {
    a: readDigital(BTN.a),
    b: readDigital(BTN.b),
    x: readDigital(BTN.x),
    y: readDigital(BTN.y),
    lb: readDigital(BTN.lb),
    rb: readDigital(BTN.rb),
    lt: _deadzoneTrigger(readAnalog(BTN.lt)),
    rt: _deadzoneTrigger(readAnalog(BTN.rt)),
    start: readDigital(BTN.start),
    back: readDigital(BTN.back),
    dpadUp: readDigital(BTN.dpadUp),
    dpadDown: readDigital(BTN.dpadDown),
    dpadLeft: readDigital(BTN.dpadLeft),
    dpadRight: readDigital(BTN.dpadRight),
  };

  // Derive edges, write into public state, snapshot for next frame.
  for (const k in cur) {
    const v = cur[k];
    if (typeof v === 'number') {
      // Triggers: justPressed fires when crossing 0.5 from below.
      const wasOn = (_prev[k] || 0) >= 0.5;
      const isOn = v >= 0.5;
      j[k] = !wasOn && isOn ? 1 : 0;
      b[k] = v;
      _prev[k] = v;
    } else {
      j[k] = !_prev[k] && v;
      b[k] = v;
      _prev[k] = v;
    }
  }
}

/**
 * Returns true if any stick is meaningfully deflected or any button is held.
 * Used to detect "gamepad was the most recent input device this frame".
 */
export function gamepadHasActivity() {
  if (!gamepadState.connected) return false;
  if (Math.hypot(gamepadState.lx, gamepadState.ly) > 0.05) return true;
  if (Math.hypot(gamepadState.rx, gamepadState.ry) > 0.05) return true;
  const b = gamepadState.buttons;
  for (const k in b) {
    const v = b[k];
    if (typeof v === 'number' ? v > 0.05 : v) return true;
  }
  return false;
}
