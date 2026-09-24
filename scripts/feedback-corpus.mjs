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
	{ text: 'vai se foder, seu canal é uma merda', lang: 'pt', expected: { category: 'none', hasAbuse: true }, note: 'pt abuse with no extractable claim' },

	// ==== Expansion to ≥100 cases (MOD-87): other niches — cooking, gaming,
	// tech, fitness, history — so the eval is not tuned to one channel type.

	// ---- English questions (expansion) ----
	{ text: 'what camera do you film with?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'gear question, filming' },
	{ text: 'how long did you let the dough rest?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'cooking process question' },
	{ text: 'which graphics card was that benchmark on?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'tech setup question' },
	{ text: 'does this recipe work with almond flour?', lang: 'en', expected: { category: 'question', hasAbuse: false }, note: 'substitution question' },
	{ text: 'what song is playing at the end, you moron', lang: 'en', expected: { category: 'question', hasAbuse: true }, note: 'music question wrapped in an insult' },

	// ---- English criticism (expansion) ----
	{ text: 'the background music is louder than your voice', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'audio mix criticism' },
	{ text: 'the intro is way too long before you get to the point', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'intro pacing criticism' },
	{ text: 'the text on screen disappears before I can read it', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'on-screen text criticism' },
	{ text: 'the camera keeps losing focus during the close-ups', lang: 'en', expected: { category: 'criticism', hasAbuse: false }, note: 'focus criticism' },
	{ text: 'the music is so fucking loud I cannot hear you', lang: 'en', expected: { category: 'criticism', hasAbuse: true }, note: 'audio mix criticism with profanity' },
	{ text: 'the jump cuts are shit, impossible to follow the steps', lang: 'en', expected: { category: 'criticism', hasAbuse: true }, note: 'editing criticism with profanity' },

	// ---- English corrections (expansion) ----
	{ text: 'water boils at 100 °C at sea level, not 90', lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'science figure correction' },
	{ text: 'the Battle of Hastings was in 1066, not 1166', lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'history date correction' },
	{ text: 'that GPU has 12 GB of VRAM, not 8', lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'tech spec correction' },
	{ text: 'the capital of Australia is Canberra, not Sydney', lang: 'en', expected: { category: 'correction', hasAbuse: false }, note: 'geography correction' },
	{ text: 'dumbass, the recipe card says 180 °C, not 280', lang: 'en', expected: { category: 'correction', hasAbuse: true }, note: 'temperature correction wrapped in an insult' },
	{ text: 'wrong again idiot, the patch released in March, not May', lang: 'en', expected: { category: 'correction', hasAbuse: true }, note: 'date correction wrapped in an insult' },

	// ---- English requests (expansion) ----
	{ text: 'please add subtitles to your videos', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'accessibility format request' },
	{ text: 'can you do a beginner version of this workout?', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'follow-up request phrased as ability question' },
	{ text: 'please put the full recipe in the description', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'description content request' },
	{ text: 'do a review of the new Steam Deck', lang: 'en', expected: { category: 'request', hasAbuse: false }, note: 'topic request, tech' },
	{ text: 'add timestamps for once, you lazy bastard', lang: 'en', expected: { category: 'request', hasAbuse: true }, note: 'format request wrapped in profanity' },
	{ text: 'upload more often you useless clown', lang: 'en', expected: { category: 'request', hasAbuse: true }, note: 'schedule request wrapped in insults' },

	// ---- English none (expansion) ----
	{ text: 'love this channel so much', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'praise' },
	{ text: 'this made my day 😂', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'reaction with emoji' },
	{ text: 'subscribe to my channel for free giveaways', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'spam / self-promotion' },
	{ text: 'lol', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'minimal chatter' },
	{ text: 'worst video ever', lang: 'en', expected: { category: 'none', hasAbuse: false }, note: 'vague dismissal, clean wording — rubric says none/clean' },
	{ text: 'you are a pathetic loser', lang: 'en', expected: { category: 'none', hasAbuse: true }, note: 'pure insult, no claim' },
	{ text: 'shut up and go die', lang: 'en', expected: { category: 'none', hasAbuse: true }, note: 'hostile phrase, no claim' },
	{ text: 'nobody asked, delete your channel', lang: 'en', expected: { category: 'none', hasAbuse: true }, note: 'person-directed hostility, no claim' },

	// ---- Portuguese questions (expansion) ----
	{ text: 'qual câmera você usa para gravar?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt gear question, filming' },
	{ text: 'quanto tempo a massa precisa descansar?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt cooking process question' },
	{ text: 'essa receita funciona com farinha de amêndoa?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt substitution question' },
	{ text: 'qual placa de vídeo você usou nesse teste?', lang: 'pt', expected: { category: 'question', hasAbuse: false }, note: 'pt tech setup question' },
	{ text: 'que música é essa no final, seu idiota?', lang: 'pt', expected: { category: 'question', hasAbuse: true }, note: 'pt music question wrapped in an insult' },
	{ text: 'porra, qual é o nome dessa ferramenta?', lang: 'pt', expected: { category: 'question', hasAbuse: true }, note: 'pt tool question with profanity' },

	// ---- Portuguese criticism (expansion) ----
	{ text: 'a música de fundo está mais alta que a sua voz', lang: 'pt', expected: { category: 'criticism', hasAbuse: false }, note: 'pt audio mix criticism' },
	{ text: 'a introdução é longa demais', lang: 'pt', expected: { category: 'criticism', hasAbuse: false }, note: 'pt intro pacing criticism' },
	{ text: 'a câmera perde o foco nos closes', lang: 'pt', expected: { category: 'criticism', hasAbuse: false }, note: 'pt focus criticism' },
	{ text: 'as legendas somem antes de dar para ler', lang: 'pt', expected: { category: 'criticism', hasAbuse: false }, note: 'pt on-screen text criticism' },
	{ text: 'a música tá alta pra caralho, não dá pra ouvir nada', lang: 'pt', expected: { category: 'criticism', hasAbuse: true }, note: 'pt audio mix criticism with profanity' },
	{ text: 'seu babaca, a imagem tá toda tremida', lang: 'pt', expected: { category: 'criticism', hasAbuse: true }, note: 'pt stabilization criticism wrapped in an insult' },

	// ---- Portuguese corrections (expansion) ----
	{ text: 'a água ferve a 100 °C ao nível do mar, não a 90', lang: 'pt', expected: { category: 'correction', hasAbuse: false }, note: 'pt science figure correction' },
	{ text: 'a capital da Austrália é Canberra, não Sydney', lang: 'pt', expected: { category: 'correction', hasAbuse: false }, note: 'pt geography correction' },
	{ text: 'essa placa tem 12 GB de memória, não 8', lang: 'pt', expected: { category: 'correction', hasAbuse: false }, note: 'pt tech spec correction' },
	{ text: 'o Brasil foi descoberto em 1500, não em 1600', lang: 'pt', expected: { category: 'correction', hasAbuse: false }, note: 'pt history date correction' },
	{ text: 'seu imbecil, a temperatura do forno é 180 °C, não 280', lang: 'pt', expected: { category: 'correction', hasAbuse: true }, note: 'pt temperature correction wrapped in an insult' },
	{ text: 'errado de novo, otário, a atualização saiu em março', lang: 'pt', expected: { category: 'correction', hasAbuse: true }, note: 'pt date correction wrapped in an insult' },

	// ---- Portuguese requests (expansion) ----
	{ text: 'coloca legenda nos vídeos, por favor', lang: 'pt', expected: { category: 'request', hasAbuse: false }, note: 'pt accessibility format request' },
	{ text: 'faz uma versão para iniciantes desse treino', lang: 'pt', expected: { category: 'request', hasAbuse: false }, note: 'pt follow-up request' },
	{ text: 'coloca a receita completa na descrição', lang: 'pt', expected: { category: 'request', hasAbuse: false }, note: 'pt description content request' },
	{ text: 'faz uma review do novo Steam Deck', lang: 'pt', expected: { category: 'request', hasAbuse: false }, note: 'pt topic request, tech' },
	{ text: 'coloca os timestamps, seu preguiçoso de merda', lang: 'pt', expected: { category: 'request', hasAbuse: true }, note: 'pt format request wrapped in profanity' },
	{ text: 'abaixa essa música, caralho', lang: 'pt', expected: { category: 'request', hasAbuse: true }, note: 'pt audio request with profanity' },

	// ---- Portuguese none (expansion) ----
	{ text: 'amo esse canal', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt praise' },
	{ text: 'kkkkkk', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt laughter chatter' },
	{ text: 'se inscreve no meu canal, sorteio toda semana', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt spam / self-promotion' },
	{ text: 'que vídeo incrível, parabéns', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt praise' },
	{ text: 'pior vídeo que já vi', lang: 'pt', expected: { category: 'none', hasAbuse: false }, note: 'pt vague dismissal, clean wording' },
	{ text: 'você é um lixo', lang: 'pt', expected: { category: 'none', hasAbuse: true }, note: 'pt pure insult, no claim' },
	{ text: 'cala a boca, ninguém te quer aqui', lang: 'pt', expected: { category: 'none', hasAbuse: true }, note: 'pt hostile phrase, no claim' },
	{ text: 'some daqui, seu verme', lang: 'pt', expected: { category: 'none', hasAbuse: true }, note: 'pt person-directed hostility, no claim' }
];
