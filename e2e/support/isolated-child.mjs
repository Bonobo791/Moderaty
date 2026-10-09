import { fork } from 'node:child_process';

/** Isolated fixture processes must not inherit parent --import/--require hooks. */
export function forkIsolated(modulePath, options) {
	return fork(modulePath, [], {...options, execArgv:[]});
}
