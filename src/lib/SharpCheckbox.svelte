<!--
# Moderaty — YouTube Comment Auto-Moderation Tool
# Copyright (C) 2026 Andrew Philip Weilbacher

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

Commercial licensing: contact@marketingprowess.simplelogin.com — see COMMERCIAL.md
-->

<!-- SharpCheckbox: 18px square, 1px --line border, --accent fill with a
     black check when checked (spec §7/Step 1.3). Native input keeps
     keyboard/focus behavior. I13: a visible label or an aria-label is
     mandatory — rendering without either throws. -->

<script lang="ts">
	let {
		checked = $bindable(false),
		label = '',
		ariaLabel = '',
		name = undefined,
		required = false,
		disabled = false
	}: {
		checked?: boolean;
		label?: string;
		ariaLabel?: string;
		name?: string;
		required?: boolean;
		disabled?: boolean;
	} = $props();

	if (!label && !ariaLabel) {
		throw new Error('SharpCheckbox requires a visible label or an aria-label (I13)');
	}
</script>

<label class="sharp-checkbox" class:disabled>
	<input
		type="checkbox"
		bind:checked
		{name}
		{required}
		{disabled}
		aria-label={ariaLabel || undefined}
	/>
	{#if label}<span class="label-text">{label}</span>{/if}
</label>

<style>
	.sharp-checkbox {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		cursor: pointer;
	}

	.sharp-checkbox.disabled {
		cursor: default;
		opacity: 0.4;
	}

	input[type='checkbox'] {
		appearance: none;
		flex: none;
		width: 18px;
		height: 18px;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		background: transparent;
		cursor: pointer;
	}

	input[type='checkbox']:checked {
		border-color: var(--accent);
		background: var(--accent)
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 10'%3E%3Cpath d='M1 5l3.5 3.5L11 1' fill='none' stroke='%230a0a0c' stroke-width='2'/%3E%3C/svg%3E")
			center / 12px no-repeat;
	}

	input[type='checkbox']:disabled {
		cursor: default;
	}

	input[type='checkbox']:focus-visible {
		outline: 1px solid var(--accent);
		outline-offset: 2px;
	}

	.label-text {
		color: var(--text);
		font-size: 14px;
	}
</style>
