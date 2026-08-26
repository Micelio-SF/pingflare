// ponytail: attempts are keyed by email only. That locks the account under
// attack rather than the attacker, which is the right trade for a single-tenant
// deployment; add a CF-Connecting-IP key too if abuse from one host shows up.

const WINDOW_MINUTES = 15;
const MAX_FAILED_ATTEMPTS = 10;
const RETENTION_HOURS = 24;

function toIdentifier(email: string): string {
	return email.trim().toLowerCase();
}

export async function isLoginRateLimited(db: D1Database, email: string): Promise<boolean> {
	const result = await db
		.prepare(
			`SELECT COUNT(*) as count FROM login_attempts
       WHERE identifier = ? AND attempted_at > datetime('now', ?)`
		)
		.bind(toIdentifier(email), `-${WINDOW_MINUTES} minutes`)
		.first<{ count: number }>();

	return (result?.count ?? 0) >= MAX_FAILED_ATTEMPTS;
}

export async function recordFailedLogin(db: D1Database, email: string): Promise<void> {
	await db
		.prepare("INSERT INTO login_attempts (identifier, attempted_at) VALUES (?, datetime('now'))")
		.bind(toIdentifier(email))
		.run();

	await db
		.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', ?)")
		.bind(`-${RETENTION_HOURS} hours`)
		.run();
}

export async function clearFailedLogins(db: D1Database, email: string): Promise<void> {
	await db
		.prepare('DELETE FROM login_attempts WHERE identifier = ?')
		.bind(toIdentifier(email))
		.run();
}
