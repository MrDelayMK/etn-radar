// Minimales Keccak-256 - nur fuer die Pruefsummen-Schreibweise einer Adresse
// (EIP-55). Die ElectroSwap-API liefert das Bestandsdokument nur unter genau
// dieser Schreibweise; klein geschrieben kommt es leer zurueck.
//
// Bewusst ohne Abhaengigkeit: der Worker soll kein Krypto-Paket mitschleppen.
// Keccak-256 ist NICHT SHA3-256 (anderes Padding), darum die eigene Runde.

const RUNDEN = 24;
const RC = [
  0x00000001n, 0x00008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const R = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const MASKE = (1n << 64n) - 1n;
const rot = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASKE;

function runde(a) {
  for (let i = 0; i < RUNDEN; i++) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) c[x] = a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rot(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x][y] ^= d;
    }
    const b = [[], [], [], [], []];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) b[y][(2 * x + 3 * y) % 5] = rot(a[x][y], R[x][y]);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) a[x][y] = b[x][y] ^ (~b[(x + 1) % 5][y] & MASKE & b[(x + 2) % 5][y]);
    }
    a[0][0] ^= RC[i];
  }
  return a;
}

/** Keccak-256 ueber Bytes, Ergebnis als Hex ohne 0x. */
export function keccak256(bytes) {
  const rate = 136; // 1088 Bit
  const eingabe = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  eingabe.set(bytes);
  eingabe[bytes.length] = 0x01; // Keccak-Padding, nicht 0x06 wie bei SHA3
  eingabe[eingabe.length - 1] |= 0x80;

  let a = [[0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n], [0n, 0n, 0n, 0n, 0n]];
  for (let block = 0; block < eingabe.length; block += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let wort = 0n;
      for (let j = 7; j >= 0; j--) wort = (wort << 8n) | BigInt(eingabe[block + i * 8 + j]);
      a[i % 5][Math.floor(i / 5)] ^= wort;
    }
    a = runde(a);
  }

  let hex = "";
  for (let i = 0; i < 4; i++) {
    let wort = a[i % 5][Math.floor(i / 5)];
    for (let j = 0; j < 8; j++) {
      hex += Number(wort & 0xffn).toString(16).padStart(2, "0");
      wort >>= 8n;
    }
  }
  return hex;
}

/** Adresse in der Pruefsummen-Schreibweise nach EIP-55. */
export function pruefsummenAdresse(adresse) {
  const klein = String(adresse).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(klein)) return String(adresse);
  const hash = keccak256(new TextEncoder().encode(klein));
  let aus = "0x";
  for (let i = 0; i < 40; i++) {
    aus += parseInt(hash[i], 16) >= 8 ? klein[i].toUpperCase() : klein[i];
  }
  return aus;
}
