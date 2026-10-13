<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Container } from '$lib/components/layout';
	import { Card, Input, Button, Alert } from '$lib/components/ui';
	import MicelioLogo from '$lib/components/MicelioLogo.svelte';

	let name = $state('');
	let email = $state('');
	let password = $state('');
	let confirmPassword = $state('');
	let error = $state('');
	let isSubmitting = $state(false);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = '';

		if (!name || !email || !password || !confirmPassword) {
			error = 'All fields are required';
			return;
		}

		if (name.length < 2) {
			error = 'Name must be at least 2 characters';
			return;
		}

		if (!email.includes('@')) {
			error = 'Please enter a valid email address';
			return;
		}

		if (password.length < 8) {
			error = 'Password must be at least 8 characters';
			return;
		}

		if (password !== confirmPassword) {
			error = 'Passwords do not match';
			return;
		}

		isSubmitting = true;

		try {
			const response = await fetch('/api/auth/setup', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, email, password })
			});

			const data = (await response.json()) as { error?: string };

			if (!response.ok) {
				error = data.error || 'Setup failed';
				return;
			}

			await goto(resolve('/dashboard'));
		} catch {
			error = 'An error occurred. Please try again.';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Setup - Micelio Status</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12">
	<Container size="sm">
		<div class="text-center">
			<MicelioLogo class="mx-auto h-12 w-12" />
			<h1 class="mt-4 text-2xl font-bold text-[#1E3A5F]">Welcome to Micelio Status</h1>
			<p class="mt-1 text-gray-600">Create your admin account to get started</p>
		</div>

		<Card class="mt-8" padding="lg">
			{#if error}
				<div class="mb-4">
					<Alert variant="error">{error}</Alert>
				</div>
			{/if}

			<form onsubmit={handleSubmit} class="space-y-4">
				<Input
					type="text"
					name="name"
					label="Name"
					placeholder="Your name"
					bind:value={name}
					required
				/>

				<Input
					type="email"
					name="email"
					label="Email"
					placeholder="admin@example.com"
					bind:value={email}
					required
				/>

				<Input
					type="password"
					name="password"
					label="Password"
					placeholder="Minimum 8 characters"
					helper="At least 8 characters"
					bind:value={password}
					required
				/>

				<Input
					type="password"
					name="confirmPassword"
					label="Confirm Password"
					placeholder="Confirm your password"
					bind:value={confirmPassword}
					required
				/>

				<Button type="submit" loading={isSubmitting} class="w-full">
					{isSubmitting ? 'Creating Account...' : 'Create Admin Account'}
				</Button>
			</form>
		</Card>

		<p class="mt-4 text-center text-sm text-gray-500">
			This will be the only admin account. You can add more users later.
		</p>
	</Container>
</div>
