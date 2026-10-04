import { mount, flushSync } from 'svelte';
import Wrapper from './Wrapper.svelte';

const component = mount(Wrapper, { target: document.getElementById('app') });
const a = { id: 'a', text: 'A', restoreIntentId: null };
const b = { id: 'b', text: 'B', restoreIntentId: null };
const update = (rows) => { component.updateRecovery(rows); flushSync(); };
const boxes = () => document.querySelectorAll('input[name=confirmRestore]');

try {
	update([a, b]);
	boxes()[0].checked = true;
	update([b]);
	if (boxes()[0].checked) throw new Error('confirmation transferred to another comment');
	boxes()[0].checked = true;
	update([{ ...b, restoreIntentId: 8 }]);
	if (boxes()[0].checked) throw new Error('confirmation survived a changed binding');
	update([a, b]);
	boxes()[1].checked = true;
	update([b, a]);
	if (!boxes()[0].checked || boxes()[1].checked) throw new Error('confirmation did not follow the same comment and binding');
	document.body.dataset.result = 'passed';
} catch (error) {
	document.body.dataset.result = error.message;
}
