// Stored password hashes are self-describing: `pbkdf2$<iterations>$<saltB64>$<hashB64>`.
// Hashes written before PBKDF2 are bare SHA-256 hex; they still verify and are
// upgraded to PBKDF2 the next time the user logs in successfully.

// ponytail: 100k iterations is the ceiling Workers allows for PBKDF2 and keeps
// login inside the free-tier CPU budget. Raise it if the plan allows more.
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const LEGACY_SHA256_HEX = /^[0-9a-f]{64}$/;

// Uint8Array is generic over its backing buffer; WebCrypto only accepts the
// plain ArrayBuffer variant, so bytes are pinned to it throughout.
type Bytes = Uint8Array<ArrayBuffer>;

type StoredHash =
	| { algorithm: 'pbkdf2'; iterations: number; salt: Bytes; digest: Bytes }
	| { algorithm: 'sha256'; digest: Bytes };

function toBase64(bytes: Bytes): string {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Bytes {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function fromHex(value: string): Bytes {
	const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

async function deriveKey(password: string, salt: Bytes, iterations: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
		key,
		KEY_BITS
	);
	return new Uint8Array(bits);
}

async function digestSha256(password: string): Promise<Bytes> {
	const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
	return new Uint8Array(bits);
}

function parseStoredHash(stored: string): StoredHash | null {
	if (LEGACY_SHA256_HEX.test(stored)) {
		return { algorithm: 'sha256', digest: fromHex(stored) };
	}

	const [scheme, iterations, salt, digest] = stored.split('$');
	if (scheme !== 'pbkdf2' || !iterations || !salt || !digest) return null;

	const rounds = Number(iterations);
	if (!Number.isInteger(rounds) || rounds < 1) return null;

	try {
		return {
			algorithm: 'pbkdf2',
			iterations: rounds,
			salt: fromBase64(salt),
			digest: fromBase64(digest)
		};
	} catch {
		return null;
	}
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) {
		difference |= a[i] ^ b[i];
	}
	return difference === 0;
}

export function timingSafeEqualString(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const digest = await deriveKey(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(digest)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parsed = parseStoredHash(stored);
	if (!parsed) return false;

	const computed =
		parsed.algorithm === 'pbkdf2'
			? await deriveKey(password, parsed.salt, parsed.iterations)
			: await digestSha256(password);

	return timingSafeEqual(computed, parsed.digest);
}

/** True when a stored hash uses an outdated scheme and should be rewritten on next login. */
export function needsRehash(stored: string): boolean {
	const parsed = parseStoredHash(stored);
	return !parsed || parsed.algorithm !== 'pbkdf2' || parsed.iterations < PBKDF2_ITERATIONS;
}
