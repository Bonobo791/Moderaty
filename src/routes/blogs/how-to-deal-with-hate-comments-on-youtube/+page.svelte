<script lang="ts">
	import BlogMeta from '$lib/components/blogs/BlogMeta.svelte';
	import ArticleContents from '$lib/components/blogs/ArticleContents.svelte';
	import { BLOG_AUTHOR } from '$lib/blogs/author';
	import { HATE_COMMENTS, HATE_COMMENT_SECTIONS as sections } from '$lib/blogs/hate-comments';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
</script>

<BlogMeta {...HATE_COMMENTS} origin={data.siteOrigin} article />

<nav class="breadcrumbs" aria-label="Breadcrumb">
	<ol><li><a href="/">Home</a></li><li><a href="/blogs/">Blogs</a></li><li aria-current="page">Hate comments on YouTube</li></ol>
</nav>
<article class="blog-article">
	<h1>{HATE_COMMENTS.title}</h1>
	<p class="byline">By <a href="#about-the-author">{BLOG_AUTHOR.name}</a></p>
	<ArticleContents headings={Object.values(sections)} />

	<h2 id={sections.summary.id} tabindex="-1">{sections.summary.title}</h2>
	<p>Choose an action based on what the commenter is doing. Keep useful criticism, reply when a clear answer helps, remove personal attacks that break your rules, hide repeat offenders, and report threats or doxxing. If a comment has upset you, pause before replying; you can set boundaries without arguing in public.</p>

	<h2 id={sections.takeaways.id} tabindex="-1">{sections.takeaways.title}</h2>
	<ul aria-label="Key takeaways">
		<li><a href="#criticism-or-attack">A negative comment can still contain useful feedback.</a> Separate the point from the insult before deciding what to do.</li>
		<li><a href="#reply-to-negative-comments">Reply when you can answer a question, correct a mistake or clarify your video.</a> You do not owe a reply to a personal attack.</li>
		<li><a href="#remove-or-hide">Use channel rules to decide when to remove or hide comments.</a> Report threats, doxxing or serious harassment.</li>
		<li><a href="#reduce-hate-comments">Filters and review queues can reduce what you have to read</a>, but check what they hold before approving or rejecting it.</li>
	</ul>

	<h2 id={sections.action.id} tabindex="-1">{sections.action.title}</h2>
	<p>These fictional examples show the difference between common moderation choices. They are not quotes from real viewers. You can choose more than one action, and you do not need to reply or give a warning before reporting a serious threat.</p>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll this named table region.) -->
	<div class="table-scroll" role="region" aria-labelledby="actions-caption" tabindex="0">
		<table>
			<caption id="actions-caption">Actions for hate comments</caption>
			<thead><tr><th scope="col">What you see</th><th scope="col">Possible action</th><th scope="col">Why</th></tr></thead>
			<tbody>
				<tr><th scope="row">“This video was boring.”</th><td>Leave it alone.</td><td>A negative opinion does not need a reply if it fits your channel rules.</td></tr>
				<tr><th scope="row">“The total at 4:12 leaves out shipping.”</th><td>Check and reply if useful.</td><td>Acknowledge a valid correction and update the video or description.</td></tr>
				<tr><th scope="row">“You are an idiot.”</th><td>Remove the comment if it breaks your rules.</td><td>Personal attacks do not need to stay up for you to keep any useful feedback.</td></tr>
				<tr><th scope="row">One account repeatedly targets you or viewers.</th><td>Hide the commenter from your channel.</td><td>This sets a broader boundary than removing one comment.</td></tr>
				<tr><th scope="row">A threat or someone sharing your private address.</th><td>Save evidence, report it and consider hiding the person.</td><td>Get help outside YouTube if you feel unsafe.</td></tr>
			</tbody>
		</table>
	</div>

	<h2 id={sections.criticism.id} tabindex="-1">{sections.criticism.title}</h2>
	<p>“Hate comment” can mean anything from a blunt disagreement to targeted abuse. Ask whether the comment gives you something specific to check. “The music makes your voice hard to hear” points to an audio problem. “Your voice is disgusting” attacks you. They call for different decisions.</p>
	<p>Some comments contain both. A viewer might identify a wrong price and add an insult. Verify the price, fix it if needed, then apply your rule to the insult. Removing a comment does not prevent you from correcting the video.</p>
	<p>A hurtful comment does not automatically violate YouTube policy. The <a href="https://support.google.com/youtube/answer/2802268?hl=en" target="_blank" rel="noopener">harassment and cyberbullying policy</a> covers conduct such as threats, doxxing and certain targeted abuse. Your channel can also remove behavior that breaks its own rules.</p>
	<p>For a borderline case, ask whether you would make the same decision if the person agreed with you. Apply the same standard to supporters and critics. If someone helps moderate, share examples of comments you would keep and remove.</p>

	<h2 id={sections.reply.id} tabindex="-1">{sections.reply.title}</h2>
	<p>Reply when you have a useful answer, correction or clarification. Other viewers may have the same question, so a short reply can help them even if the original commenter stays annoyed.</p>
	<p>For a shipping-cost correction, you might say: “You’re right. I left shipping out of that total. I’ve added the full cost to the description.” Use a reply like this only after checking the claim and making the correction.</p>
	<p>If someone misunderstood your point, explain it once and point to the relevant part of the video. If they return with another personal attack, stop the exchange and use your moderation rules. Skip the reply when all you have is a comeback.</p>
	<p>If the comment has upset you, step away before answering. A moderation decision can wait until you have more distance, unless someone has made a threat or shared private information that needs attention now.</p>

	<h2 id={sections.remove.id} tabindex="-1">{sections.remove.title}</h2>
	<p>To remove a published comment, find it in YouTube Studio and use its menu to choose Remove; the <a href="https://support.google.com/youtube/answer/15535966?hl=en&amp;co=GENIE.Platform%3DDesktop" target="_blank" rel="noopener">YouTube moderation guide</a> walks through comment actions.</p>
	<p>On YouTube, open a comment&#x27;s menu and choose Hide from channel to hide the commenter across your channel. YouTube says hidden users are not notified, and their past comments no longer appear on your Studio comments page. See <a href="https://support.google.com/youtube/answer/9482361?hl=en" target="_blank" rel="noopener">YouTube&#x27;s instructions for hiding a user</a> before taking action.</p>
	<h3 id="report-harassment" tabindex="-1">Report abuse and save the evidence</h3>
	<p><a href="https://support.google.com/youtube/answer/2802027?hl=en&amp;co=GENIE.Platform%3DDesktop" target="_blank" rel="noopener">Report a comment</a> when it violates YouTube&#x27;s policies. Reporting asks YouTube to review it; it does not guarantee removal. You can also use YouTube&#x27;s <a href="https://support.google.com/youtube/answer/142443" target="_blank" rel="noopener">privacy complaint process</a> for personal information concerns.</p>
	<p>If a comment contains a specific threat or private information, save a screenshot and the available link before removing it. Record the date and account name somewhere private. Do not repost someone’s private details or ask viewers to confront them.</p>
	<p>If someone makes a specific threat and you feel unsafe, YouTube advises <a href="https://support.google.com/youtube/answer/2802268?hl=en" target="_blank" rel="noopener">contacting local law enforcement</a>.</p>
	<p>If you are in immediate danger, contact local emergency services.</p>

	<h2 id={sections.reduce.id} tabindex="-1">{sections.reduce.title}</h2>
	<p>YouTube’s <a href="https://support.google.com/youtube/answer/9483359?hl=en" target="_blank" rel="noopener">comment settings</a> let you hold potentially inappropriate comments for review, use stricter filters, hold all comments or turn comments off for a video. Held comments stay out of public view unless you approve them, and YouTube keeps them for review for up to 60 days. Check the queue before that window ends.</p>
	<p>YouTube is also <a href="https://blog.youtube/news-and-events/made-on-youtube-new-tools-power-creation-journey/" target="_blank" rel="noopener">testing opt-in AI comment moderation</a> that learns a channel&#x27;s moderation style. Check whether it is available to your channel before relying on it.</p>
	<p>Keep blocked-word rules narrow. Blocking a word such as “wrong” could hide a correction you would want to see. After you change a filter, check whether it held legitimate comments and adjust the rule if needed.</p>
	<p>For an existing video, review its comment controls in YouTube Studio. The <a href="https://support.google.com/youtube/answer/9482556?hl=en" target="_blank" rel="noopener">YouTube settings instructions</a> explain how to update an individual video and your channel defaults. Changing defaults affects new uploads; update existing videos separately.</p>
	<p>Set a review window you can stop at. If you catch yourself rereading the same insult, close the thread. You can also ask someone you trust to pass on useful feedback without repeating abusive wording.</p>
	<h3 id="channel-rules" tabindex="-1">Apply your channel rules consistently</h3>
	<p>A short channel policy can help you act consistently. For example: “Disagreement and corrections are welcome. Keep replies about the video or the point being discussed. We remove personal attacks, threats and private information. Repeated abuse may lead us to hide your account from the channel.”</p>
	<p>Base moderation decisions on your channel rules and safety needs. Do not keep abuse visible for an assumed boost in reach. A comment count alone cannot show what removing a comment will do to recommendations.</p>

	<h2 id={sections.preview.id} tabindex="-1">{sections.preview.title}</h2>
	<p>YouTube&#x27;s built-in controls may be enough. If you want automated comment decisions, <a href="/">Moderaty</a> uses AI scoring and sends uncertain decisions to a human review queue. Any rules you add apply before AI scoring.</p>
	<p>You can first try <a href="/#faq">Moderaty&#x27;s free moderation dry run</a> to preview decisions without changing comments. Review the preview for mistakes, including criticism it would remove or abuse it would leave up. Check that the preview includes cases that matter to your channel. Deleted comments cannot be restored, and Moderaty cannot lift an author ban.</p>
	<p>Before enabling automatic actions, confirm which comment types and history window the tool covers. Keep reviewing replies and YouTube&#x27;s own held queue until you have confirmed coverage. Test the setup against examples you want to keep and examples you want to remove.</p>

	<h2 id={sections.faq.id} tabindex="-1">{sections.faq.title}</h2>
	<h3>Is every negative YouTube comment hate?</h3>
	<p>No. A comment can be negative and still contain useful criticism. Check whether it points to something you can verify, then separate that point from any personal attack.</p>
	<h3>Will a commenter know if I hide them from my channel?</h3>
	<p>YouTube says it does not notify a user when you hide them. Their past comments also stop appearing on your Studio comments page. Read the current <a href="https://support.google.com/youtube/answer/9482361?hl=en" target="_blank" rel="noopener">hide-user instructions</a> before choosing this channel-wide action.</p>
	<h3>How long do held YouTube comments stay in review?</h3>
	<p>YouTube says held comments stay in the review queue for up to 60 days. Check your queue before that period ends. The <a href="https://support.google.com/youtube/answer/9483359?hl=en" target="_blank" rel="noopener">comment settings guide</a> explains the review controls.</p>
	<h3>Should I reply to someone who is insulting me?</h3>
	<p>Only if you can add something useful, such as a factual correction or a clear answer. You can remove or report abuse under your rules without debating the commenter.</p>

	<h2 id={sections.author.id} tabindex="-1">{sections.author.title}</h2>
	<p>{BLOG_AUTHOR.bio}</p>
</article>
