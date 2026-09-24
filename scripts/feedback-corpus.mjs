// Labeled feedback corpus (MOD-87): hand-labeled EN + PT comments covering
// every digest category, abuse-wrapped variants, and `none`. Consumed by
// scripts/feedback-eval.mjs (live faithfulness + abuse-leak check) and by
// its deterministic leak gate in feedback-eval.test.mjs.
//
// Labels are deliberately unambiguous: a case whose expected category or
// hasAbuse could honestly go either way does not belong here — borderline
// wording would turn the eval into noise instead of a gate.
//
//   text:     the raw comment (eval input)
//   lang:     'en' | 'pt'
//   expected: { category, hasAbuse } the classifier must return
//   note:     why the case exists (what it proves)

export const FEEDBACK_CORPUS = [
	// ---- English questions ----
	{ text: 'when is the next video coming?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'schedule question' },
	{ text: 'what mic do you use?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'gear question' },
	{ text: 'where did you get that torque wrench?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'tool question' },
	{ text: 'is this safe for aluminum heads?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'process question' },
	{ text: 'yo dumbass what mic is that', lang: 'en', expected: { category: 'question', hasAbuse: true }, note: 'question wrapped in an insult — claim survives, abuse flag set' },
	{ text: 'what the hell is that tool called, idiot', lang: 'en', expected: { category: 'question', hasAbuse: true }, note: 'question + profanity + insult' },

	// ---- English criticism ----
	{ text: 'the middle section dragged, trim the montage', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'pacing criticism' },
	{ text: 'the audio at 3:00 is blown out', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'audio criticism' },
	{ text: 'the lighting washes out the whole bench', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'production criticism' },
	{ text: 'this was boring as shit, the middle drags forever', lang: 'en', expected: { category: 'criticism', hasAbuse: true }, note: 'criticism with profanity — claim is the pacing note' },
	{ text: 'you idiot, your audio is blown at 3:00', lang: 'en', expected: { category: 'criticism', hasAbuse: true }, note: 'criticism wrapped in an insult' },

	// ---- English corrections ----
	{ text: "the torque spec at 4:20 is wrong — it's 25 ft-lb", lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'specific factual correction' },
	{ text: 'premium fuel is not required, the manual says 87 octane', lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'correction citing the manual' },
	{ text: 'that bolt is M8, not M10', lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'size correction' },
	{ text: 'moron, the plug gap is 0.028 not 0.035', lang: 'en', expected: { category: 'correction', hasAbuse: true }, note: 'correction wrapped in an insult' },
	{ text: 'you stupid fuck, that is a 13mm socket', lang: 'en', expected: { category: 'correction', hasAbuse: true }, note: 'correction wrapped in profanity' },

	// ---- English requests ----
	{ text: 'please do a video on carb tuning', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'topic request' },
	{ text: 'do a part two on the timing chain', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'follow-up request' },
	{ text: 'can you make one about drum brakes?', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'topic request as a question of ability' },
	{ text: 'make a part two you lazy fuck', lang: 'en', expected: { category: 'request', hasAbuse: true }, note: 'request wrapped in profanity' },
	{ text: 'fix your thumbnails, they are trash', lang: 'en', expected: { category: 'request', hasAbuse: true }, note: 'request + mild insult on the artifact' },

	// ---- English none ----
	{ text: 'great video!', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'praise — no feedback' },
	{ text: 'first!', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'chatter' },
	{ text: 'check out my channel for daily uploads', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'self-promotion' },
	{ text: 'f*** you and this garbage channel', lang: 'en', expected: { category: 'none', hasAbuse: true }, note: 'abuse with no extractable claim — dropped entirely' },
	{ text: 'everything in this video is wrong', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'sweeping dismissal with no specifics — criticism at best, keep strict: none' },

	// ---- Portuguese questions ----
	{ text: 'quando sai o próximo vídeo?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt schedule question' },
	{ text: 'que microfone você usa?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt gear question' },
	{ text: 'onde você comprou essa chave de torque?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt tool question' },
	{ text: 'seu burro, que microfone é esse?', lang: 'pt', expected: { category: 'question', hasAbuse: true }, note: 'pt question wrapped in an insult' },

	// ---- Portuguese criticism ----
	{ text: 'o meio do vídeo ficou arrastado', lang: 'pt', expected: { category: 'criticism', hasAbuse: false }, note: 'pt pacing criticism' },
	{ text: 'o áudio tá estourando aos 3:00', lang: 'pt', expected: { category: 'criticism', hasAbuse: false }, note: 'pt audio criticism' },
	{ text: 'vídeo chato pra caralho, a parte do meio arrasta', lang: 'pt', expected: { category: 'criticism', hasAbuse: true }, note: 'pt criticism with profanity' },
	{ text: 'seu idiota, o áudio tá estourado aos 3:00', lang: 'pt', expected: { category: 'criticism', hasAbuse: true }, note: 'pt criticism wrapped in an insult' },

	// ---- Portuguese corrections ----
	{ text: 'o torque é 25 Nm, não 35', lang: 'pt', expected: { category: 'correction', hasAbuse: false }, note: 'pt figure correction' },
	{ text: 'aquela porca é M8, não M10', lang: 'pt', expected: { category: 'correction', hasAbuse: false }, note: 'pt size correction' },
	{ text: 'seu burro, a folga é 0.028 e não 0.035', lang: 'pt', expected: { category: 'correction', hasAbuse: true }, note: 'pt correction wrapped in an insult' },

	// ---- Portuguese requests ----
	{ text: 'faz um vídeo sobre regulagem de carburador', lang: 'pt', expected: { category: 'request', hasAbuse: false }, note: 'pt topic request' },
	{ text: 'faz a parte dois sobre corrente de comando', lang: 'pt', expected: { category: 'request', hasAbuse: false }, note: 'pt follow-up request' },
	{ text: 'faz a parte dois, seu vagabundo', lang: 'pt', expected: { category: 'request', hasAbuse: true }, note: 'pt request wrapped in an insult' },

	// ---- Portuguese none ----
	{ text: 'ótimo vídeo!', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt praise' },
	{ text: 'primeiro!', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt chatter' },
	{ text: 'vai se foder, seu canal é uma merda', lang: 'pt', expected: { category: 'none', hasAbuse: true }, note: 'pt abuse with no extractable claim' }
];
