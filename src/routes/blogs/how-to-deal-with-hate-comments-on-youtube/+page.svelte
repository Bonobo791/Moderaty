<script lang="ts">
	import BlogMeta from '$lib/components/blogs/BlogMeta.svelte';
	import { COMMENT_SOURCES as sources, HATE_COMMENTS } from '$lib/blogs/hate-comments';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<BlogMeta {...HATE_COMMENTS} origin={data.siteOrigin} article />

<nav class="breadcrumbs" aria-label="Breadcrumb">
	<ol><li><a href="/">Home</a></li><li><a href="/blogs/">Blogs</a></li><li aria-current="page">Hate comments on YouTube</li></ol>
</nav>
<article>
	<h1>{HATE_COMMENTS.title}</h1>
	<p>To deal with hate comments on YouTube, choose an action based on what the commenter is doing. Leave useful criticism. Reply when you can answer a question or correct a mistake. Remove personal attacks, hide repeat offenders, and report threats or harassment. You can set those boundaries without defending yourself in the replies.</p>
	<p>If a comment has upset you, pause before answering. A moderation decision can wait until you've stepped away, unless someone has made a threat or exposed private information that needs attention now.</p>

	<h2 id="choose-an-action">Choose an action for a hate comment</h2>
	<p>These invented examples show how the choices differ. None comes from a real viewer or creator.</p>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll this named table region.) -->
	<div class="table-scroll" role="region" aria-labelledby="actions-caption" tabindex="0">
		<table>
			<caption id="actions-caption">Actions for hate comments</caption>
			<thead><tr><th scope="col">Action</th><th scope="col">Example</th><th scope="col">What to do</th></tr></thead>
			<tbody>
				<tr><th scope="row">Ignore</th><td>"This video was boring."</td><td>Leave it if it fits your rules. A negative opinion doesn't require a reply.</td></tr>
				<tr><th scope="row">Reply</th><td>"The total at 4:12 leaves out shipping."</td><td>Check the claim. Acknowledge a valid correction and fix what you can.</td></tr>
				<tr><th scope="row">Delete or remove</th><td>"You are an idiot."</td><td>Remove the comment if personal attacks break your rules. Keep any useful feedback separately.</td></tr>
				<tr><th scope="row">Hide the user</th><td>One account keeps attacking you or other viewers.</td><td>Hide the commenter when you want a boundary across your channel, beyond one comment.</td></tr>
				<tr><th scope="row">Report</th><td>A threat or someone posting your private address.</td><td>Save evidence, report the comment, then remove or hide it. Seek help beyond YouTube if you feel unsafe.</td></tr>
			</tbody>
		</table>
	</div>
	<p>These are choices, not steps you must try in order. You can report and hide the same person. A serious threat doesn't require a warning or a reply first.</p>
	<p>If YouTube has held a comment and you're unsure about it, leave it in the review queue while you check the context. <a href={sources.settings}>Held comments stay out of public view until you approve them.</a></p>

	<h2 id="criticism-or-attack">Tell useful criticism from a personal attack</h2>
	<p>A negative comment can tell you something worth checking. A viewer might disagree with your conclusion or struggle to hear your voice over the music. You can keep that feedback even if they phrase it badly.</p>
	<p>Compare these invented comments: "The music makes your voice hard to hear" and "Your voice is disgusting. Stop making videos." The first points to an audio problem. The second attacks you. They call for different decisions.</p>
	<p>Some comments contain both. For example, a viewer might identify a wrong price and add an insult. Note the price correction, verify it, and apply your rules to the insult. Removing the comment doesn't prevent you from fixing the video.</p>
	<p>For a borderline case, ask whether you'd make the same decision if the person agreed with you. Apply the same personal-attack rule to supporters and critics. If someone helps moderate, show them examples of both comments you would keep and comments you would remove.</p>
	<p>A hurtful comment isn't automatically a YouTube policy violation. <a href={sources.harassment}>YouTube's harassment policy</a> covers conduct including threats, doxxing and certain targeted abuse. You can also remove behavior that breaks your own channel rules without waiting for YouTube to act.</p>

	<h2 id="reply-to-negative-comments">Reply to negative comments when you can help the reader</h2>
	<p>Reply when you have a useful answer, a correction or a clarification. Other viewers may have the same question, so a brief explanation can serve them even if the original commenter stays annoyed.</p>
	<p>For the shipping-cost example, you could write: "You're right. I left shipping out of that total. I've added the full cost to the description." Use that reply only after making the correction.</p>
	<p>If someone misunderstood your point, explain it once and point to the relevant part of the video. If they return with another personal attack, stop the exchange and use your moderation rules. Skip a reply when all you have is a comeback.</p>
	<p><a href={sources.reply}>YouTube may notify a commenter when you reply, depending on their settings.</a> Before posting, decide whether reopening the conversation is worth your attention.</p>

	<h2 id="remove-or-hide">Remove a comment or hide the user from your channel</h2>
	<p>Remove deals with the individual comment. Hide from channel affects the commenter's visibility across your channel. Choose the scope you need: one bad reply doesn't always call for the same action as someone repeatedly targeting your viewers.</p>
	<p>To remove a published comment on a computer, open YouTube Studio and select Community. In the Published tab, open the comment's three-dot menu and choose Remove. The <a href={sources.moderate}>YouTube moderation guide</a> documents this action.</p>
	<p>To hide a commenter, find one of their comments on your channel or video, open its three-dot menu and select Hide from channel. <a href={sources.hide}>YouTube says hidden users aren't notified.</a> Their past comments also disappear from your Studio comments page.</p>
	<p><a href={sources.settings}>Hiding applies across your videos, and comments from hidden users won't appear in your Studio review queue.</a> Check the surrounding conversation before hiding someone over an ambiguous joke or a blunt disagreement. For serious abuse, you can act without offering another chance.</p>

	<h2 id="report-harassment">Report harassment and threats before removing the evidence</h2>
	<p>Save screenshots and available links before you clear a threatening comment. Record the date and account name somewhere private. Avoid reposting private details or asking your audience to confront the person.</p>
	<p>On a computer, open the comment's three-dot menu, choose Report, select the reason and submit. <a href={sources.report}>Reporting asks YouTube to review the content; it doesn't guarantee removal.</a> YouTube also provides a privacy complaint route for privacy concerns. You can report a comment and hide its author.</p>
	<p>If someone makes a specific threat and you feel unsafe, <a href={sources.harassment}>YouTube advises contacting local law enforcement.</a> In immediate danger, contact local emergency services rather than waiting for YouTube's response.</p>

	<h2 id="reduce-hate-comments">Reduce the hate comments you have to read</h2>
	<p>Use YouTube's controls before the next upload. <a href={sources.settings}>Basic moderation holds potentially inappropriate comments; Strict holds a broader range. Hold all keeps comments from public view until approval.</a> The filters can make mistakes, so check what they catch.</p>
	<p>During a wave of abuse, <a href={sources.settings}>pause comments on the affected video.</a> Existing comments remain, while new comments stop until you turn them back on. You can review the backlog without more comments arriving.</p>
	<p>For an existing video, open YouTube Studio, select Content and choose the video. Open Show more, adjust Comments and ratings, then save. Changing upload defaults won't change older videos. Follow <a href={sources.changeSettings}>YouTube's settings instructions</a> for the option you need.</p>
	<p>Keep blocked-word rules narrow. Blocking a word such as "wrong" could catch corrections you want to read. After changing a filter, look for legitimate comments it has held and adjust it if needed.</p>
	<p>Choose a review window you can stop at. If you catch yourself rereading the same insult, close the thread. Ask someone you trust to pass on useful feedback without repeating the abuse word for word.</p>
	<p>You can <a href={sources.moderate}>add a YouTube comment moderator without sharing your login.</a> Native comment moderators can hold comments for your review; that role doesn't give them access to your channel in Studio. Agree on the boundaries and which decisions need your attention.</p>

	<h2 id="channel-rules">Keep your channel rules separate from algorithm guesses</h2>
	<p>A short policy helps you apply the same standard from one upload to the next. You could adapt this example:</p>
	<blockquote><p>"Disagreement and corrections are welcome. Keep replies about the video or the point being discussed. We remove personal attacks, threats and private information. Repeated abuse may lead us to hide your account from the channel."</p></blockquote>
	<p>Follow that policy for fans as well as critics. If you keep removing comments you would otherwise want to read, revise the rule instead of treating all disagreement as hate.</p>
	<p>Don't keep abuse up for a supposed engagement boost. A comment adding to a visible count doesn't establish what removing it will do to recommendations. Claims that deleting negative comments harms your reach need evidence; they shouldn't decide your moderation policy.</p>

	<h2 id="preview-moderation">Preview moderation before allowing automatic actions</h2>
	<p>YouTube's native controls may cover what you need. If you want custom rules to take actions and a separate queue for uncertain comments, <a href="/#how-it-works">Moderaty applies your rules before AI scoring and records completed actions in an audit log.</a> Borderline decisions go to human review.</p>
	<p>Start with Moderaty's moderation dry run, which previews decisions without changing comments. <a href="/#faq">Each connected channel gets one free moderation dry run without spending credits.</a> Review the preview for mistakes, including legitimate criticism it would remove and abuse it would leave up.</p>
	<p>Among the comments in the preview, look for a blunt correction or an inside joke that needs context. If the preview doesn't cover those cases, don't treat it as proof the setup can handle them. Deleted comments cannot be restored, and Moderaty cannot lift an author's ban.</p>
	<p>See <a href="/#faq">Moderaty's moderation and preview details</a>, then compare the proposed decisions with the rules you want for your channel.</p>
</article>
