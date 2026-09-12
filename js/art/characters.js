// characters.js — hand-drawn chibi character sprites (pure canvas, no external
// assets). Every character in the game is drawn by a small function in a
// 100x100 local box. The SAME sprite is used everywhere a character appears:
//   - chessboard pieces (via makeCharacterCanvas)
//   - the danmaku player ship (the protagonist in the fight)
//   - the danmaku boss (the youkai being fought)
//   - the fight-modal portrait
//
// Appearance details were verified against the Touhou Wiki character pages
// (saved in refs/) — hair/eye colors, outfits and signature items below
// follow those descriptions.

const ART_TAU = Math.PI * 2;
const ART_SKIN = '#ffe3d0';

// ---- tiny drawing helpers (100x100 local space) ----
function _C(ctx, x, y, r, f) { ctx.fillStyle = f; ctx.beginPath(); ctx.arc(x, y, r, 0, ART_TAU); ctx.fill(); }
function _E(ctx, x, y, rx, ry, rot, f) { ctx.fillStyle = f; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot || 0, 0, ART_TAU); ctx.fill(); }
function _R(ctx, x, y, w, h, f) { ctx.fillStyle = f; ctx.fillRect(x, y, w, h); }
function _P(ctx, pts, f) {
  ctx.fillStyle = f; ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath(); ctx.fill();
}
function _L(ctx, x1, y1, x2, y2, w, c) {
  ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
function _star(ctx, x, y, ro, ri, n, rot, f) {
  ctx.fillStyle = f; ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const rad = i % 2 === 0 ? ro : ri;
    const a = (i / (n * 2)) * ART_TAU + (rot || 0);
    const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.fill();
}
function _face(ctx, x, y, r, eye, skin) {
  _C(ctx, x, y, r, skin || ART_SKIN);
  _E(ctx, x - r * 0.38, y + r * 0.12, r * 0.16, r * 0.22, 0, eye);
  _E(ctx, x + r * 0.38, y + r * 0.12, r * 0.16, r * 0.22, 0, eye);
  ctx.globalAlpha = 0.3;
  _C(ctx, x - r * 0.62, y + r * 0.45, r * 0.16, '#ff9aa0');
  _C(ctx, x + r * 0.62, y + r * 0.45, r * 0.16, '#ff9aa0');
  ctx.globalAlpha = 1;
  _L(ctx, x - r * 0.12, y + r * 0.52, x + r * 0.12, y + r * 0.52, Math.max(1, r * 0.08), '#a05050');
}
// Draw only the right (or left) half of the 100x100 box (Youmu's split).
function _half(ctx, right, fn) {
  ctx.save();
  ctx.beginPath();
  if (right) ctx.rect(50, -10, 60, 120); else ctx.rect(-10, -10, 60, 120);
  ctx.clip();
  fn(ctx);
  ctx.restore();
}

// =====================================================================
// The 18 characters. Each draw(ctx) paints in the 100x100 box.
// =====================================================================

const CHAR_SPRITES = {

  // ---------- Protagonists (white) ----------

  // Reimu Hakurei — king. Dark-brown hair, big red ribbon at the back of the
  // head, red tubes on the sidelocks, red-and-white shrine maiden outfit,
  // wind bell on the chest.
  reimu: {
    draw(ctx) {
      // red ribbon (behind the head)
      _P(ctx, [[50, 18], [26, 6], [32, 28]], '#e02030');
      _P(ctx, [[50, 18], [74, 6], [68, 28]], '#e02030');
      _C(ctx, 50, 18, 5, '#c01525');
      // long dark-brown hair
      _E(ctx, 50, 46, 26, 30, 0, '#4a3728');
      _E(ctx, 28, 58, 6, 16, 0.15, '#4a3728');
      _E(ctx, 72, 58, 6, 16, -0.15, '#4a3728');
      // face + bangs
      _face(ctx, 50, 38, 19, '#cc2233');
      _E(ctx, 50, 28, 21, 11, 0, '#4a3728');
      // sidelocks with red tubes
      _R(ctx, 26, 42, 5, 12, '#4a3728'); _R(ctx, 26, 45, 5, 3, '#e02030');
      _R(ctx, 69, 42, 5, 12, '#4a3728'); _R(ctx, 69, 45, 5, 3, '#e02030');
      // body: red top + red skirt, white collar, white detached sleeves
      _P(ctx, [[38, 56], [62, 56], [66, 94], [34, 94]], '#d42030');
      _P(ctx, [[42, 56], [58, 56], [50, 66]], '#f5f0e8');
      _C(ctx, 33, 64, 6, '#f5f0e8'); _C(ctx, 67, 64, 6, '#f5f0e8');
      // wind bell
      _C(ctx, 50, 70, 3, '#e8c040'); _L(ctx, 50, 67.5, 50, 72.5, 1, '#8a6a1a');
    },
  },

  // Marisa Kirisame — queen. Blonde hair (braid on one side), yellow eyes,
  // black witch hat with a white bow, black vest + skirt over white apron,
  // broom over the shoulder.
  marisa: {
    draw(ctx) {
      // broom (behind)
      _L(ctx, 70, 50, 88, 88, 3, '#a07038');
      _E(ctx, 90, 92, 7, 9, 0.5, '#d0a858');
      // blonde hair + braid
      _E(ctx, 50, 40, 22, 24, 0, '#f0c040');
      _E(ctx, 68, 58, 4, 10, 0.3, '#f0c040');
      _E(ctx, 72, 70, 4, 10, 0.5, '#f0c040');
      _C(ctx, 75, 79, 3, '#d04040');
      // face + bangs
      _face(ctx, 50, 40, 18, '#d0a020');
      _E(ctx, 50, 30, 20, 10, 0, '#f0c040');
      // witch hat with white bow
      _E(ctx, 50, 22, 26, 7, 0, '#1a1a1a');
      _P(ctx, [[50, -4], [36, 22], [64, 22]], '#1a1a1a');
      _P(ctx, [[50, 10], [40, 5], [42, 16]], '#f5f5f5');
      _P(ctx, [[50, 10], [60, 5], [58, 16]], '#f5f5f5');
      _C(ctx, 50, 10, 3, '#f5f5f5');
      // body: white shirt, black vest, black skirt, white apron
      _P(ctx, [[40, 56], [60, 56], [63, 74], [37, 74]], '#f5f5f0');
      _P(ctx, [[40, 56], [47, 56], [45, 74], [37, 74]], '#1a1a1a');
      _P(ctx, [[60, 56], [53, 56], [55, 74], [63, 74]], '#1a1a1a');
      _P(ctx, [[37, 74], [63, 74], [67, 94], [33, 94]], '#1a1a1a');
      _P(ctx, [[44, 66], [56, 66], [58, 88], [42, 88]], '#f5f5f0');
    },
  },

  // Sakuya Izayoi — rook. Silver hair in long braids with green bows, white
  // maid headband, red eyes, dark-blue French maid outfit with white apron
  // and green ribbon, pocket watch.
  sakuya: {
    draw(ctx) {
      // braids with green bows
      _E(ctx, 27, 60, 5, 16, 0.15, '#d8dce8');
      _E(ctx, 73, 60, 5, 16, -0.15, '#d8dce8');
      _C(ctx, 27, 75, 3, '#40a060'); _C(ctx, 73, 75, 3, '#40a060');
      // pocket watch
      _C(ctx, 75, 64, 5, '#e8c040'); _C(ctx, 75, 64, 3.5, '#fff');
      _L(ctx, 75, 64, 75, 61.5, 1, '#333');
      // silver hair
      _E(ctx, 50, 39, 22, 22, 0, '#d8dce8');
      _face(ctx, 50, 38, 18, '#e03040');
      _E(ctx, 50, 29, 20, 10, 0, '#d8dce8');
      // white maid headband
      _R(ctx, 32, 24, 36, 5, '#f5f5f0');
      // body: dark-blue dress, white apron, pink collar, green ribbon
      _P(ctx, [[38, 56], [62, 56], [66, 94], [34, 94]], '#2a3560');
      _P(ctx, [[43, 60], [57, 60], [60, 90], [40, 90]], '#f5f5f0');
      _P(ctx, [[44, 56], [56, 56], [50, 62]], '#f0a0b0');
      _C(ctx, 50, 64, 2.5, '#40a060');
    },
  },

  // Youmu Konpaku — rook. Short silver hair split half white / half black
  // (her two halves), blue eyes, aquamarine vest + skirt over white on the
  // human side, black on the phantom side.
  youmu: {
    draw(ctx) {
      // hair: white base, black right half
      _E(ctx, 50, 39, 22, 23, 0, '#e8e8f0');
      _half(ctx, true, (c) => _E(c, 50, 39, 22, 23, 0, '#20202a'));
      // long side locks (white left, black right)
      _E(ctx, 29, 55, 5, 16, 0.2, '#e8e8f0');
      _E(ctx, 71, 55, 5, 16, -0.2, '#20202a');
      // face + bangs (split)
      _face(ctx, 50, 38, 18, '#4090d0');
      _E(ctx, 50, 29, 20, 10, 0, '#e8e8f0');
      _half(ctx, true, (c) => _E(c, 50, 29, 20, 10, 0, '#20202a'));
      // body: aquamarine left half, black right half, white undershirt
      _P(ctx, [[38, 56], [50, 56], [50, 94], [34, 94]], '#70c0c8');
      _P(ctx, [[50, 56], [62, 56], [66, 94], [50, 94]], '#2a2a35');
      _L(ctx, 50, 56, 50, 94, 2, '#f5f5f0');
      _P(ctx, [[34, 88], [66, 88], [68, 94], [32, 94]], '#f5f5f0');
      // ghost insignia on the aquamarine side
      _C(ctx, 42, 70, 2, '#fff'); _C(ctx, 40, 80, 2, '#fff');
    },
  },

  // Sanae Kochiya — bishop. Light-green hair with a blue snake wrapped
  // around it, yellow eyes, blue-and-white shrine maiden outfit with
  // polka dots, gohei staff.
  sanae: {
    draw(ctx) {
      // gohei staff (right side)
      _L(ctx, 79, 42, 79, 95, 3, '#a07038');
      _P(ctx, [[74, 44], [84, 42], [84, 50], [74, 52]], '#f5f5f0');
      _P(ctx, [[74, 54], [84, 52], [84, 60], [74, 62]], '#f5f5f0');
      // light-green hair
      _E(ctx, 50, 46, 26, 30, 0, '#b8e090');
      _E(ctx, 28, 60, 6, 16, 0.15, '#b8e090');
      _E(ctx, 72, 60, 6, 16, -0.15, '#b8e090');
      // face + bangs
      _face(ctx, 50, 38, 18, '#d0b020');
      _E(ctx, 50, 29, 20, 10, 0, '#b8e090');
      // blue snake in the hair
      _E(ctx, 65, 30, 8, 4, 0.5, '#3a80c0');
      _C(ctx, 72, 26, 2.5, '#3a80c0');
      // body: white top, blue dotted skirt
      _P(ctx, [[38, 56], [62, 56], [64, 72], [36, 72]], '#f5f5f0');
      _P(ctx, [[44, 56], [56, 56], [50, 62]], '#3a6ac0');
      _P(ctx, [[36, 72], [64, 72], [68, 94], [32, 94]], '#3a6ac0');
      _C(ctx, 44, 80, 2, '#e8f0ff'); _C(ctx, 56, 84, 2, '#e8f0ff');
      _C(ctx, 50, 78, 2, '#e8f0ff'); _C(ctx, 62, 79, 2, '#e8f0ff');
    },
  },

  // Reisen Udongein Inaba — bishop. Long purple hair, red eyes, very long
  // rabbit ears (white with red insides), white shirt with red tie,
  // orange skirt.
  reisen: {
    draw(ctx) {
      // long rabbit ears
      _E(ctx, 38, 12, 6, 16, -0.15, '#f5f5f0');
      _E(ctx, 62, 12, 6, 16, 0.15, '#f5f5f0');
      _E(ctx, 38, 14, 3, 11, -0.15, '#e05060');
      _E(ctx, 62, 14, 3, 11, 0.15, '#e05060');
      // purple hair
      _E(ctx, 50, 46, 24, 30, 0, '#b088d8');
      _E(ctx, 28, 60, 6, 16, 0.15, '#b088d8');
      _E(ctx, 72, 60, 6, 16, -0.15, '#b088d8');
      // face + bangs
      _face(ctx, 50, 40, 18, '#d03040');
      _E(ctx, 50, 30, 20, 10, 0, '#b088d8');
      // body: white shirt, red tie, orange skirt
      _P(ctx, [[38, 56], [62, 56], [64, 74], [36, 74]], '#f5f5f0');
      _P(ctx, [[48, 56], [52, 56], [54, 70], [50, 74], [46, 70]], '#d02030');
      _P(ctx, [[36, 74], [64, 74], [68, 94], [32, 94]], '#e89868');
    },
  },

  // Aya Shameimaru — knight. Short black hair, red eyes, bat wings, white
  // blouse, black skirt, tengu tokin with red feather, hauchiwa fan.
  aya: {
    draw(ctx) {
      // bat wings
      _P(ctx, [[36, 58], [10, 36], [16, 52], [6, 50], [22, 70], [36, 70]], '#3a3a44');
      _P(ctx, [[64, 58], [90, 36], [84, 52], [94, 50], [78, 70], [64, 70]], '#3a3a44');
      // black hair
      _E(ctx, 50, 38, 20, 20, 0, '#2a2a30');
      _face(ctx, 50, 38, 17, '#d03040');
      _E(ctx, 50, 29, 19, 9, 0, '#2a2a30');
      // tengu tokin with red feather
      _E(ctx, 50, 24, 18, 6, 0, '#1a1a1a');
      _P(ctx, [[50, 2], [38, 24], [62, 24]], '#1a1a1a');
      _E(ctx, 64, 8, 3, 9, 0.6, '#d02030');
      // body: white blouse, black skirt
      _P(ctx, [[38, 56], [62, 56], [63, 70], [37, 70]], '#f5f5f0');
      _P(ctx, [[37, 70], [63, 70], [67, 92], [33, 92]], '#1a1a1a');
      // hauchiwa fan
      _E(ctx, 73, 62, 8, 10, 0.3, '#f0e8d8');
      _C(ctx, 73, 62, 3, '#d02030');
    },
  },

  // Hatate Himekaidou — knight. Long brown hair in pigtails with purple
  // ribbons, brown eyes, purple tokin, pinkish shirt with black tie,
  // black/purple checkered skirt.
  hatate: {
    draw(ctx) {
      // pigtails with purple ribbons
      _E(ctx, 25, 52, 6, 20, 0.1, '#8a5a3a');
      _E(ctx, 75, 52, 6, 20, -0.1, '#8a5a3a');
      _C(ctx, 26, 38, 4, '#8050c0'); _C(ctx, 74, 38, 4, '#8050c0');
      // brown hair
      _E(ctx, 50, 38, 20, 20, 0, '#8a5a3a');
      _face(ctx, 50, 38, 17, '#7a4a2a');
      _E(ctx, 50, 29, 19, 9, 0, '#8a5a3a');
      // purple tokin
      _E(ctx, 50, 24, 17, 6, 0, '#6a4a9a');
      _P(ctx, [[50, 4], [39, 24], [61, 24]], '#6a4a9a');
      // body: pink shirt, black tie, checkered skirt
      _P(ctx, [[38, 56], [62, 56], [64, 72], [36, 72]], '#f0c0c8');
      _P(ctx, [[44, 56], [56, 56], [50, 61]], '#6a4a9a');
      _P(ctx, [[48, 56], [52, 56], [53, 67], [50, 71], [47, 67]], '#1a1a1a');
      _P(ctx, [[36, 72], [64, 72], [68, 92], [32, 92]], '#2a2a35');
      _R(ctx, 40, 76, 6, 6, '#6a4a9a'); _R(ctx, 54, 76, 6, 6, '#6a4a9a');
      _R(ctx, 47, 83, 6, 6, '#6a4a9a');
    },
  },

  // Cirno — pawn. Aqua hair and eyes, blue ribbon, light-pink blouse,
  // blue jumper dress, icicle-shaped wings.
  cirno: {
    draw(ctx) {
      // icicle wings
      _P(ctx, [[36, 58], [12, 46], [20, 60], [10, 62], [26, 72], [36, 70]], '#b0e8f0');
      _P(ctx, [[64, 58], [88, 46], [80, 60], [90, 62], [74, 72], [64, 70]], '#b0e8f0');
      // aqua hair
      _E(ctx, 50, 38, 20, 20, 0, '#70d8e8');
      _face(ctx, 50, 38, 17, '#40b8d0');
      _E(ctx, 50, 29, 19, 9, 0, '#70d8e8');
      // blue ribbon
      _P(ctx, [[50, 18], [36, 10], [40, 24]], '#4080d0');
      _P(ctx, [[50, 18], [64, 10], [60, 24]], '#4080d0');
      _C(ctx, 50, 18, 3.5, '#4080d0');
      // body: pink blouse, blue dress
      _P(ctx, [[38, 56], [62, 56], [63, 66], [37, 66]], '#f8d8e0');
      _P(ctx, [[37, 66], [63, 66], [67, 92], [33, 92]], '#4080d0');
    },
  },

  // ---------- Bosses (black) ----------

  // Kaguya Houraisan — king. Very long black hair in a hime cut, dark-brown
  // eyes, pink shirt with white bows, long dark-burgundy skirt with the
  // four-seasons flowers.
  kaguya: {
    draw(ctx) {
      // very long black hair (hime cut)
      _E(ctx, 50, 48, 27, 34, 0, '#1a1a22');
      _R(ctx, 24, 44, 8, 28, '#1a1a22');
      _R(ctx, 68, 44, 8, 28, '#1a1a22');
      // face + straight bangs
      _face(ctx, 50, 38, 18, '#5a3a28');
      _E(ctx, 50, 28, 21, 11, 0, '#1a1a22');
      // body: pink top with white bows, burgundy skirt
      _P(ctx, [[38, 56], [62, 56], [64, 74], [36, 74]], '#f0a0b8');
      _C(ctx, 44, 62, 2.5, '#fff'); _C(ctx, 56, 62, 2.5, '#fff');
      _P(ctx, [[36, 74], [64, 74], [68, 94], [32, 94]], '#6a1a30');
      // four seasons: cherry / bamboo / maple / plum
      _C(ctx, 42, 82, 2, '#f0a0b0');
      _C(ctx, 50, 86, 2, '#70b060');
      _C(ctx, 58, 82, 2, '#d04040');
      _C(ctx, 50, 78, 2, '#f5f0f0');
    },
  },

  // Yukari Yakumo — queen. Blonde wavy hair, purple eyes, purple coat with
  // red ribbon trim, white veil, and her signature glowing boundary holes.
  yukari: {
    draw(ctx) {
      // white veil behind
      _C(ctx, 50, 46, 31, '#f0f0f5');
      // boundary holes (glowing purple voids)
      _C(ctx, 14, 30, 9, 'rgba(120,60,200,0.35)'); _C(ctx, 14, 30, 5, '#3a1a6a');
      _C(ctx, 86, 54, 8, 'rgba(120,60,200,0.35)'); _C(ctx, 86, 54, 4.5, '#3a1a6a');
      // blonde wavy hair
      _E(ctx, 50, 44, 24, 28, 0, '#e8c860');
      _E(ctx, 27, 60, 6, 11, 0.2, '#e8c860');
      _E(ctx, 73, 60, 6, 11, -0.2, '#e8c860');
      // face + bangs
      _face(ctx, 50, 38, 18, '#8040c0');
      _E(ctx, 50, 29, 21, 11, 0, '#e8c860');
      // body: purple coat, white frill, red ribbon trim
      _P(ctx, [[36, 56], [64, 56], [68, 94], [32, 94]], '#6a3a9a');
      _P(ctx, [[42, 56], [58, 56], [50, 64]], '#f5f5f0');
      _L(ctx, 50, 64, 50, 94, 2, '#d02030');
      _C(ctx, 50, 66, 3, '#d02030');
      _R(ctx, 33, 66, 6, 4, '#d02030'); _R(ctx, 61, 66, 6, 4, '#d02030');
    },
  },

  // Remilia Scarlet — rook. Short light-blue hair, red eyes, light-pink mob
  // cap with red ribbon, light-pink dress with red ribbons, large black
  // bat wings.
  remilia: {
    draw(ctx) {
      // black bat wings
      _P(ctx, [[36, 56], [6, 30], [14, 48], [4, 44], [20, 66], [36, 68]], '#1a1a20');
      _P(ctx, [[64, 56], [94, 30], [86, 48], [96, 44], [80, 66], [64, 68]], '#1a1a20');
      // light-pink mob cap with red ribbon
      _E(ctx, 50, 26, 20, 10, 0, '#f0c0d0');
      _P(ctx, [[50, 8], [36, 26], [64, 26]], '#f0c0d0');
      _P(ctx, [[50, 14], [40, 9], [42, 20]], '#d02030');
      _P(ctx, [[50, 14], [60, 9], [58, 20]], '#d02030');
      _C(ctx, 50, 14, 3, '#d02030');
      // light-blue hair
      _E(ctx, 50, 36, 19, 18, 0, '#90c8e8');
      _face(ctx, 50, 38, 17, '#e02030');
      _E(ctx, 50, 29, 18, 9, 0, '#90c8e8');
      // body: light-pink dress with red ribbons
      _P(ctx, [[38, 56], [62, 56], [66, 94], [34, 94]], '#f0b8c8');
      _C(ctx, 42, 64, 3, '#d02030'); _C(ctx, 58, 64, 3, '#d02030');
      _P(ctx, [[50, 72], [38, 68], [40, 78]], '#d02030');
      _P(ctx, [[50, 72], [62, 68], [60, 78]], '#d02030');
      _C(ctx, 50, 72, 3.5, '#d02030');
    },
  },

  // Yuyuko Saigyouji — rook. Short wavy pink hair, maroon eyes, pale skin,
  // light-blue-and-white kimono with dark-blue trim, blue mob cap with a
  // red ghost insignia, blue veil.
  yuyuko: {
    draw(ctx) {
      // blue veil
      _C(ctx, 50, 46, 31, '#c8d8f0');
      // blue mob cap with red insignia
      _E(ctx, 50, 26, 20, 10, 0, '#4a6ab0');
      _P(ctx, [[50, 8], [36, 26], [64, 26]], '#4a6ab0');
      _C(ctx, 50, 16, 3, '#d02030');
      // pink hair
      _E(ctx, 50, 38, 19, 18, 0, '#e8a8c0');
      _face(ctx, 50, 38, 17, '#803040', '#f5eef5');
      _E(ctx, 50, 29, 18, 9, 0, '#e8a8c0');
      // body: light-blue kimono, dark-blue trim, obi
      _P(ctx, [[38, 56], [62, 56], [66, 94], [34, 94]], '#c8e0f0');
      _P(ctx, [[44, 56], [56, 56], [50, 64]], '#2a4a8a');
      _L(ctx, 50, 64, 50, 94, 2.5, '#2a4a8a');
      _R(ctx, 37, 72, 26, 6, '#4a6ab0');
      // butterfly motif on the shoulders
      _E(ctx, 40, 60, 3, 5, 0.6, '#2a4a8a');
      _E(ctx, 60, 60, 3, 5, -0.6, '#2a4a8a');
    },
  },

  // Patchouli Knowledge — bishop. Purple hair in twintails with ribbons,
  // purple eyes, round glasses, pink pajama-like robe, night-cap with a
  // gold crescent moon, grimoire.
  patchouli: {
    draw(ctx) {
      // grimoire (left side)
      _R(ctx, 19, 58, 13, 17, '#8050b0');
      _L(ctx, 23, 61, 23, 72, 1.5, '#f5f0f0');
      // night-cap with gold crescent
      _E(ctx, 50, 22, 18, 9, 0, '#f0a8c0');
      _P(ctx, [[50, 2], [36, 22], [64, 22]], '#f0a8c0');
      _C(ctx, 50, 11, 4, '#e8c040');
      _C(ctx, 52.5, 10, 3.4, '#f0a8c0');
      // purple hair + twintails
      _E(ctx, 50, 38, 20, 20, 0, '#9060c0');
      _E(ctx, 25, 52, 6, 16, 0.2, '#9060c0');
      _E(ctx, 75, 52, 6, 16, -0.2, '#9060c0');
      _C(ctx, 25, 38, 3, '#f0a8c0'); _C(ctx, 75, 38, 3, '#f0a8c0');
      // face + bangs
      _face(ctx, 50, 38, 17, '#8050b0');
      _E(ctx, 50, 29, 19, 9, 0, '#9060c0');
      // round glasses
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(43, 38, 5.5, 0, ART_TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(57, 38, 5.5, 0, ART_TAU); ctx.stroke();
      _L(ctx, 48.5, 38, 51.5, 38, 1.5, '#333');
      // body: pink robe with white collar
      _P(ctx, [[38, 56], [62, 56], [66, 94], [34, 94]], '#f0a8c0');
      _P(ctx, [[44, 56], [56, 56], [50, 64]], '#f5f5f0');
    },
  },

  // Alice Margatroid — bishop. Long blonde hair, gold eyes, black dress
  // with white frills, grimoire, and a little doll on strings.
  alice: {
    draw(ctx) {
      // grimoire (left)
      _R(ctx, 20, 58, 12, 16, '#4a2a5a');
      _C(ctx, 26, 66, 1.5, '#e8c040');
      // doll (right): black hair, white dress
      _C(ctx, 77, 58, 4, '#2a2a30');
      _C(ctx, 77, 62, 3, ART_SKIN);
      _P(ctx, [[73, 64], [81, 64], [82, 78], [72, 78]], '#f5f5f0');
      _L(ctx, 70, 70, 76, 62, 1, '#ccc');
      // blonde hair
      _E(ctx, 50, 44, 24, 28, 0, '#f0d060');
      _E(ctx, 28, 58, 6, 14, 0.15, '#f0d060');
      _E(ctx, 72, 58, 6, 14, -0.15, '#f0d060');
      // face + bangs
      _face(ctx, 50, 38, 18, '#d0a020');
      _E(ctx, 50, 29, 21, 11, 0, '#f0d060');
      // body: black dress with white frills
      _P(ctx, [[38, 56], [62, 56], [66, 94], [34, 94]], '#1a1a1a');
      _P(ctx, [[44, 56], [56, 56], [50, 63]], '#f5f5f0');
      _R(ctx, 36, 64, 28, 2, '#f5f5f0');
      _R(ctx, 35, 74, 30, 2, '#f5f5f0');
    },
  },

  // Nitori Kawashiro — knight. Blue twintail hair, blue eyes, green kappa
  // hat with a white symbol, blue dress with pockets, white collar, cattail.
  nitori: {
    draw(ctx) {
      // cattail (right)
      _L(ctx, 76, 42, 82, 66, 3, '#a07038');
      _E(ctx, 78, 38, 3.5, 7, 0.2, '#6a4a2a');
      // blue twintails
      _E(ctx, 25, 50, 6, 18, 0.2, '#4090d0');
      _E(ctx, 75, 50, 6, 18, -0.2, '#4090d0');
      // green kappa hat
      _E(ctx, 50, 24, 19, 7, 0, '#40a060');
      _P(ctx, [[50, 4], [37, 24], [63, 24]], '#40a060');
      _C(ctx, 50, 14, 3, '#f5f5f0');
      // blue hair + face
      _E(ctx, 50, 38, 19, 18, 0, '#4090d0');
      _face(ctx, 50, 38, 17, '#3080c0', '#cfe8f0');
      _E(ctx, 50, 29, 18, 9, 0, '#4090d0');
      // body: white collar, blue dress with pockets
      _P(ctx, [[44, 56], [56, 56], [50, 62]], '#f5f5f0');
      _P(ctx, [[38, 56], [62, 56], [66, 94], [34, 94]], '#3a6ac0');
      _R(ctx, 40, 78, 7, 6, '#2a4a8a'); _R(ctx, 53, 78, 7, 6, '#2a4a8a');
    },
  },

  // Momiji Inubashiri — knight. Short silver hair, wolf ears, red tengu
  // tokin, white shirt, black skirt with red flames, white shield with a
  // red maple leaf.
  momiji: {
    draw(ctx) {
      // scimitar (behind, diagonal)
      _L(ctx, 18, 74, 46, 50, 3, '#c0c0c8');
      // wolf ears
      _P(ctx, [[32, 24], [38, 4], [45, 20]], '#d8d8e0');
      _P(ctx, [[55, 20], [62, 4], [68, 24]], '#d8d8e0');
      _P(ctx, [[35, 20], [38, 9], [42, 18]], '#a0a0b0');
      _P(ctx, [[58, 18], [62, 9], [65, 20]], '#a0a0b0');
      // red tokin
      _E(ctx, 50, 25, 18, 6, 0, '#d02030');
      _P(ctx, [[50, 5], [38, 25], [62, 25]], '#d02030');
      // silver hair + face
      _E(ctx, 50, 38, 19, 18, 0, '#e8e8f0');
      _face(ctx, 50, 38, 17, '#d06030');
      _E(ctx, 50, 29, 18, 9, 0, '#e8e8f0');
      // body: white shirt, black skirt with red flames
      _P(ctx, [[38, 56], [62, 56], [64, 72], [36, 72]], '#f5f5f0');
      _P(ctx, [[36, 72], [64, 72], [68, 94], [32, 94]], '#1a1a1a');
      _P(ctx, [[38, 94], [44, 84], [48, 94]], '#d02030');
      _P(ctx, [[50, 94], [56, 84], [60, 94]], '#d02030');
      // white shield with red maple leaf
      _C(ctx, 77, 66, 11, '#f5f5f0');
      _star(ctx, 77, 66, 6, 2.6, 5, -Math.PI / 2, '#d02030');
    },
  },

  // Rumia — pawn. Short blonde hair, red eyes, white blouse with red tie,
  // black vest and skirt, two large red beads, red ofuda in her hair.
  rumia: {
    draw(ctx) {
      // blonde hair
      _E(ctx, 50, 36, 20, 19, 0, '#f0d060');
      // red ofuda tied to the side of the hair
      _R(ctx, 64, 18, 5, 11, '#d02030');
      _L(ctx, 64, 22, 69, 22, 1, '#8a1020');
      // face + bangs
      _face(ctx, 50, 38, 17, '#d02030');
      _E(ctx, 50, 28, 19, 10, 0, '#f0d060');
      // body: white blouse, red tie, black vest, black skirt
      _P(ctx, [[38, 56], [62, 56], [63, 68], [37, 68]], '#f5f5f0');
      _P(ctx, [[48, 56], [52, 56], [53, 65], [50, 69], [47, 65]], '#d02030');
      _P(ctx, [[38, 56], [45, 56], [43, 74], [37, 74]], '#1a1a1a');
      _P(ctx, [[62, 56], [55, 56], [57, 74], [63, 74]], '#1a1a1a');
      _P(ctx, [[37, 68], [63, 68], [67, 94], [33, 94]], '#1a1a1a');
      // two large red beads
      _C(ctx, 45, 60, 3.5, '#d02030'); _C(ctx, 55, 60, 3.5, '#d02030');
    },
  },
};

// ---------------------------------------------------------------------
// Public API.

// Draw a character sprite. (x, y) is the top-left of the 100x100 box scaled
// by `scale`. Returns true if the character exists, false otherwise.
function drawCharacter(ctx, id, x, y, scale) {
  const s = CHAR_SPRITES[id];
  if (!s) return false;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  s.draw(ctx);
  ctx.restore();
  return true;
}

// Render a character into a fresh square canvas (for DOM use: board pieces,
// trays, promotion picker, portraits).
function makeCharacterCanvas(id, size) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  const pad = size * 0.03;
  drawCharacter(ctx, id, pad, pad, (size - pad * 2) / 100);
  return cv;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CHAR_SPRITES, drawCharacter, makeCharacterCanvas };
}
