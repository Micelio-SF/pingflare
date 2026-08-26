import { describe, it, expect } from 'bun:test';
import { hashPassword, verifyPassword, needsRehash, timingSafeEqualString } from './crypto';

async function legacySha256Hex(password: string): Promise<string> {
	const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

describe('hashPassword', () => {
	it('should produce a self-describing pbkdf2 hash', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(hash.startsWith('pbkdf2$100000$')).toBe(true);
		expect(hash.split('$')).toHaveLength(4);
	});

	it('should salt each hash independently', async () => {
		const first = await hashPassword('same password');
		const second = await hashPassword('same password');
		expect(first).not.toBe(second);
	});
});

describe('verifyPassword', () => {
	it('should accept the correct password', async () => {
		const hash = await hashPassword('s3cret-passphrase');
		expect(await verifyPassword('s3cret-passphrase', hash)).toBe(true);
	});

	it('should reject a wrong password', async () => {
		const hash = await hashPassword('s3cret-passphrase');
		expect(await verifyPassword('s3cret-passphras', hash)).toBe(false);
	});

	it('should still accept a legacy sha256 hash', async () => {
		const legacy = await legacySha256Hex('old-password');
		expect(await verifyPassword('old-password', legacy)).toBe(true);
		expect(await verifyPassword('other-password', legacy)).toBe(false);
	});

	it('should reject a malformed hash instead of throwing', async () => {
		expect(await verifyPassword('anything', 'pbkdf2$notanumber$aaa$bbb')).toBe(false);
		expect(await verifyPassword('anything', '')).toBe(false);
	});
});

describe('needsRehash', () => {
	it('should be true for legacy and malformed hashes', async () => {
		expect(needsRehash(await legacySha256Hex('old-password'))).toBe(true);
		expect(needsRehash('garbage')).toBe(true);
	});

	it('should be true for a weaker iteration count', () => {
		expect(needsRehash('pbkdf2$1000$c2FsdA==$ZGlnZXN0')).toBe(true);
	});

	it('should be false for a current hash', async () => {
		expect(needsRehash(await hashPassword('fresh'))).toBe(false);
	});
});

describe('timingSafeEqualString', () => {
	it('should compare by content, not identity', () => {
		expect(timingSafeEqualString('secret', 'secret')).toBe(true);
		expect(timingSafeEqualString('secret', 'secreT')).toBe(false);
		expect(timingSafeEqualString('secret', 'secret-longer')).toBe(false);
	});
});
