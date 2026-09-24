// Deterministic abuse lexicon for evidence concealment (MOD-68). The
// sanitizer — not the LLM — decides what wording is hidden, so a
// misbehaving classifier can never leak abuse into the digest. Terms are
// stored pre-normalized (lowercase, diacritics stripped, leet chars left
// literal) and matched on the sanitizer's normalized copy with strict word
// boundaries, so "class" never matches "ass" and "computar" never matches
// "puta".
//
// Coverage is intentionally conservative: common English and Portuguese
// profanity, slurs, and person-directed insults. Mild vocabulary stays
// readable; anything the lexicon misses falls back to the classifier's
// hasAbuse flag, which conceals the whole comment rather than risking a
// partial leak.

/** @type {readonly string[]} */
export const ABUSE_TERMS = [
	// English profanity and person-directed insults
	'fuck', 'fucking', 'fucked', 'fucker', 'motherfucker', 'fck', 'fuk',
	'shit', 'shitty', 'bullshit', 'bitch', 'bitchy', 'bastard', 'asshole',
	'arsehole', 'cunt', 'dick', 'dickhead', 'cock', 'cocksucker', 'pussy',
	'whore', 'slut', 'skank', 'hoe', 'twat', 'wanker', 'douche', 'douchebag',
	'jackass', 'dumbass', 'smartass', 'fatass', 'prick', 'scumbag', 'scum',
	'dipshit', 'shithead', 'fuckwit', 'shitbag', 'asshat',
	'idiot', 'idiots', 'moron', 'morons', 'imbecile', 'retard', 'retarded',
	'stupid', 'dumb', 'loser', 'pathetic', 'trash', 'garbage human',
	'worthless', 'useless', 'clown', 'clowns', 'pig', 'pigs',
	// English slurs and dehumanizing terms
	'faggot', 'fag', 'dyke', 'tranny', 'nigger', 'nigga', 'negroes',
	'kike', 'chink', 'spic', 'wetback', 'gook', 'raghead', 'towelhead',
	'shemale', 'homo',
	// Common obfuscations and abbreviations (single-vowel '*' masks like
	// "f*ck" are generated automatically by the sanitizer)
	'f**k', 's**t', 'a**hole',
	// 'pos' is deliberately absent: after diacritic folding it hits pós,
	// posição, etc. — common benign Portuguese words (coderabbit).
	'wtf', 'stfu', 'gtfo', 'kys', 'fml',
	// Person-directed phrases
	'kill yourself', 'go die', 'die already', 'neck yourself',
	'go to hell', 'shut up', 'nobody likes you', 'nobody asked',
	'delete your channel', 'quit youtube', 'get a life', 'grow up loser',
	// Portuguese profanity and person-directed insults
	'porra', 'caralho', 'merda', 'bosta', 'puta', 'puto', 'putaria',
	'foder', 'fodido', 'fodida', 'fdp', 'vsf', 'vai se foder',
	'cuzao', 'arrombado', 'arrombada', 'cu', 'viado', 'viadinho',
	'bicha', 'bichinha', 'sapatao', 'traveco', 'otario', 'otaria',
	'babaca', 'cretino', 'cretina', 'imbecil', 'idiota', 'burro',
	'burra', 'vagabundo', 'vagabunda', 'desgraca', 'desgracado',
	'canalha', 'corno', 'corna', 'lixo', 'verme', 'nojento', 'nojenta',
	'pnc', 'tnc', 'vtnc', 'seu lixo', 'vai tomar no cu',
	'vai a merda', 'vai pra merda', 'cala a boca', 'cala boca',
	'ninguem te quer', 'some daqui', 'se mata', 'morre', 'morra'
];
