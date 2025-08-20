// utils/identity.js
const LS_USER_ID_KEY = 'score_user_id';

export function getUserId() {
  return localStorage.getItem(LS_USER_ID_KEY) || null;
}

export function getOrCreateUserId() {
  let id = getUserId();
  if (id) return id;
  id = generateStableId();
  localStorage.setItem(LS_USER_ID_KEY, id);
  return id;
}

export function resetUserId() {
  localStorage.removeItem(LS_USER_ID_KEY);
}

function generateStableId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  const buf = new Uint8Array(16);
  (crypto && crypto.getRandomValues ? crypto.getRandomValues(buf) : fallbackRandom(buf));
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = [...buf].map(b => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0,4).join('')}-${hex.slice(4,6).join('')}-${hex.slice(6,8).join('')}-${hex.slice(8,10).join('')}-${hex.slice(10,16).join('')}`;
}
function fallbackRandom(buf) {
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
}