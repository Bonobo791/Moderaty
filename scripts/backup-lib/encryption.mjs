import { gzipSync, gunzipSync } from 'node:zlib';
import { BackupError, MAX_BYTES, atStage, run, sha256 } from './common.mjs';

export function recipientConfig(env = process.env) {
	const recipient = env.BACKUP_AGE_RECIPIENT;
	if (!/^age1[0-9a-z]{58}$/.test(recipient ?? '')) throw new BackupError('configuration', 'BACKUP_AGE_RECIPIENT must be one approved native age X25519 public recipient.');
	return { recipient, keyId: sha256(recipient).slice(0, 24) };
}
export async function encryptDump(dump, recipient, { signal, runTool = run } = {}) {
	return atStage('encryption', async () => {
		const version = (await runTool('age', ['--version'], { signal, maxBytes: 4096 })).toString().trim();
		if (version !== 'v1.2.1' && version !== '1.2.1') throw new Error('unreviewed age');
		const encrypted = await runTool('age', ['--encrypt', '--recipient', recipient], { input: gzipSync(dump), signal, maxBytes: MAX_BYTES + 1024 * 1024 });
		if (!encrypted.subarray(0, Buffer.byteLength('age-encryption.org/v1\n')).equals(Buffer.from('age-encryption.org/v1\n')) || encrypted.length < 100) throw new Error('invalid ciphertext');
		return encrypted;
	});
}
export async function decryptDump(encrypted, identityPath, { signal, runTool = run } = {}) {
	return atStage('decryption', async () => {
		const gzip = await runTool('age', ['--decrypt', '--identity', identityPath], { input: encrypted, signal });
		return gunzipSync(gzip, { maxOutputLength: MAX_BYTES });
	});
}
