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

<p>These Terms are drafted to comply with the Brazilian Consumer Protection Code (Lei no 8.078/1990 — CDC), the LGPD (Lei no 13.709/2018), the Marco Civil da Internet (Lei no 12.965/2014), and the ECA Digital (Lei no 15.211/2025), and with the YouTube API Services Terms of Service.</p>

<h2 id="s1">1. Agreement and Acceptance</h2>

<p><strong>1.1</strong> These Terms of Service (Terms) are a binding contract between you (you, the User) and the operator of the Moderaty service identified in Section 21 (Moderaty, we, us), a sole proprietorship registered in Brazil. They govern your access to and use of Moderaty, a web-based YouTube comment moderation service (the Service).</p>

<p><strong>1.2</strong> You accept these Terms by ticking the acceptance checkbox at sign-up, by making a purchase, or by using the Service. The full text of these Terms is made available to you before acceptance, and you can download or print it. If you do not agree, do not use the Service.</p>

<p><strong>1.3</strong> These Terms incorporate by reference: (a) our <a href="/privacy">Privacy Policy</a>; (b) the <a href="/dpa">Data Processing Agreement (DPA)</a>, which governs comment data we process on your behalf; and (c) the price and plan information displayed at checkout. In case of conflict regarding personal data protection, the DPA prevails.</p>

<h2 id="s2">2. Definitions</h2>

<p><strong>Comment Data:</strong> personal data of third-party comment authors contained in comments retrieved from your YouTube channel(s).</p>

<p><strong>Credits:</strong> prepaid units entitling you to a defined volume of moderated comments.</p>

<p><strong>Moderation Action:</strong> an automated action configured by you (such as holding, hiding, removing, or reporting comments) executed via the YouTube API Services.</p>

<p><strong>Moderation Outcome Data:</strong> the minimal record we keep of each action (comment ID reference, comment text truncated to 500 characters, verdict, action, timestamp, and the commenter's public handle — shown in the activity log for up to 30 days, then erased automatically, and erasable on demand at any time). No other author identifiers are included.</p>

<p><strong>Consumer:</strong> a user qualifying as a consumidor under Article 2 of the CDC.</p>

<h2 id="s3">3. Eligibility and Your Account</h2>

<p><strong>3.1</strong> You must be at least 18 years old and capable of forming a binding contract to use the Service. The Service is a professional tool directed exclusively at adults and businesses; it is not directed at children or adolescents, and we do not knowingly offer it to them.</p>

<p><strong>3.2</strong> If you use the Service on behalf of a company or another person, you represent and warrant that you have authority to bind that entity or person, and you refers to that entity or person.</p>

<p><strong>3.3</strong> You must connect a YouTube channel you own or are authorized to manage, via Google OAuth. You are responsible for your OAuth grants, credentials, and everything done through your account. Notify us immediately of unauthorized use.</p>

<p><strong>3.4</strong> You must provide accurate registration and billing information and keep it current.</p>

<h2 id="s4">4. The Service</h2>

<p><strong>4.1</strong> The Service retrieves comments from your connected YouTube channel(s) via the YouTube API Services, classifies them automatically (including detection of hate speech and related abusive content), and executes the Moderation Actions you configure.</p>

<p><strong>4.2</strong> We minimize comment data: comment text (truncated to 500 characters) is stored as part of Moderation Outcome Data, and the commenter's public handle appears with it in the activity log for up to 30 days, is then erased automatically, and can be erased on demand at any time. Other comment author identifiers are processed in memory only and never retained — no author channel IDs are kept and no author profiles are built — except identifiers you enter in user rules or the protected-handles list, which are stored as your own configuration — as described in the DPA and Privacy Policy.</p>

<p><strong>4.3</strong> The Service is a tool. Automated classification may produce false positives or false negatives. You are responsible for reviewing your configuration and its effects on your channel (see Section 9).</p>

<h2 id="s5">5. YouTube API Services and Third-Party Terms</h2>

<p><strong>5.1</strong> The Service uses YouTube API Services. By using the Service, you agree to be bound by the YouTube Terms of Service, available at <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">https://www.youtube.com/t/terms</a>, and by the YouTube Community Guidelines.</p>

<p><strong>5.2</strong> Our use of information received from YouTube API Services is described in our Privacy Policy, which references the Google Privacy Policy at <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">https://policies.google.com/privacy</a>.</p>

<p><strong>5.3</strong> You can revoke the Service's access to your YouTube data at any time via the Google security settings page at <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">https://security.google.com/settings/security/permissions</a>. Revoking access disables the Service for the affected channel; Moderation Outcome Data is then handled as described in the DPA.</p>

<p><strong>5.4</strong> We are not affiliated with, sponsored, or endorsed by YouTube or Google. YouTube and Google are not parties to these Terms and have no obligations to you under them.</p>

<h2 id="s6">6. Plans, Billing and Auto Top-Up</h2>

<p><strong>6.1</strong> The Service is offered as: (a) a free self-hosted version (AGPL-3.0, your own infrastructure and OpenAI key); (b) a hosted subscription at USD 5.00 per month, automatically renewed each billing month until cancelled, including 100 moderated comments per billing month (unused monthly comments do not carry over); (c) a lifetime hosted plan at USD 49.00, one-time, limited to the first 1,000 purchasers, with unlimited moderated comments, with AI scoring run by us; and (d) comment credits, bought in bundles of 100, 500, or 2,000 comments at the prices shown at checkout — each comment your channel processes with AI scoring on a live run consumes one credit from your balance (rule matches and protected handles are never charged). Custom or volume pricing is available on request. Prices are those shown at the time of purchase. Payments are processed by our payment provider (currently Stripe); we do not store your full payment card data.</p>

<p><strong>6.2</strong> Automatic top-up is optional and off by default. If you enable it, you expressly authorize unscheduled charges: each time your credit balance drops below the threshold you configure, we charge the payment method you saved with our payment provider for the smallest credit bundle available (100, 500, or 2,000 comments), and the credits are added to your balance. Enabling auto top-up requires ticking the consent checkbox on the Usage page, whose sentence reads: "I authorize Moderaty to charge my saved payment method for comment-credit bundles automatically whenever my balance drops below the threshold I set (unscheduled top-ups, per Section 6 of the Terms of Service)." You can change the configuration or disable the automation at any time by contacting us through any channel listed in Section 21, effective for future charges.</p>

<p><strong>6.3</strong> You may cancel the subscription's renewal at any time by contacting us through any channel listed in Section 21; cancellation takes effect at the end of the current billing month. We will give at least 30 days' prior notice of any change to prices, comment allowances, or top-up rates, by e-mail and a notice in the Service. Changes apply only to charges made after the notice period. If you do not agree, you may cancel or stop purchasing; refunds are governed by Section 7.</p>

<p><strong>6.4</strong> You are responsible for applicable taxes. Prices are shown with applicable tax information at checkout.</p>

<h2 id="s7">7. Right of Withdrawal and Refunds</h2>

<p><strong>7.1</strong> If you are a Consumer, you may withdraw from your purchase within 7 (seven) days, counted from acceptance of these Terms or from the purchase, under Article 49 of the CDC, and receive a full refund of all amounts paid, at any title, without deductions of any kind, monetarily updated, and without penalty — even if you have used the Service during that period. This right applies to each charge, including subscription charges, the lifetime plan, and top-ups. To exercise this right, contact us through any channel listed in Section 21.</p>

<p><strong>7.2</strong> Outside the withdrawal period, all purchases are final and no refunds are issued — including for unconsumed Credits and including upon cancellation or closure of your account — except where required by applicable law.</p>

<p><strong class="highlight">7.3 BY MAKING A PURCHASE YOU EXPRESSLY REQUEST IMMEDIATE PERFORMANCE OF THE SERVICE. YOU ACKNOWLEDGE THAT, UNDER BRAZILIAN CASE LAW ON DIGITAL SERVICES, THE RIGHT OF WITHDRAWAL MAY BE LIMITED FOR DIGITAL SERVICES IMMEDIATELY AND FULLY CONSUMED AT YOUR REQUEST, WHERE THIS CONSEQUENCE WAS CLEARLY AND PROMINENTLY DISCLOSED BEFORE PURCHASE — AS IT IS HERE. AFTER THE 7-DAY WITHDRAWAL PERIOD, PURCHASES ARE NOT REFUNDABLE — SUBSCRIPTION CHARGES, THE LIFETIME PLAN, AND TOP-UP CREDITS ALIKE, USED OR NOT — EXCEPT WHERE REQUIRED BY APPLICABLE LAW.</strong></p>

<h2 id="s8">8. Acceptable Use</h2>

<p>You must not, and must not allow anyone to:</p>

<ul>
	<li>(a) use the Service in violation of law, the YouTube Terms of Service, the YouTube API Services Terms of Service, or third-party rights;</li>
	<li>(b) use the Service to harass, censor lawful speech unlawfully, or discriminate;</li>
	<li>(c) attempt to reverse engineer, overload, probe, or disrupt the Service, or access it by automated means other than the interfaces we provide;</li>
	<li>(d) share, resell, or sublicense access to the Service, except to users authorized within your account;</li>
	<li>(e) misrepresent your identity, your authority over a channel, or your affiliation with any person; or</li>
	<li>(f) use the Service if you are under 18 or are barred from using it under applicable law.</li>
</ul>

<h2 id="s9">9. Moderation Actions and Your Responsibility</h2>

<p><strong>9.1</strong> You choose the classification rules, thresholds, and Moderation Actions. All actions are executed on your channel, under your authority, at your instruction. You are the controller of Comment Data and are responsible for the lawfulness of your moderation decisions, including their effects on comment authors.</p>

<p><strong>9.2</strong> Automated classification is probabilistic. We do not warrant that any comment will be correctly identified as hate speech or as lawful content. You should monitor results and adjust your configuration; we provide configuration and review tools for that purpose.</p>

<p><strong>9.3</strong> Actions taken on YouTube (holding, hiding, removing, reporting) are subject to YouTube's own systems, policies, and possible reversals. We do not control and are not responsible for YouTube's treatment of a comment or channel.</p>

<p><strong>9.4</strong> Every moderation action, automatic or manual, is recorded in the Service's audit log. Hold and reject actions can be reversed from the audit log, restoring the comment on YouTube. Deleted comments cannot be restored or reversed, and author bans cannot be lifted or reversed — YouTube provides no mechanism to undo either — so both are permanent once executed.</p>

<h2 id="s10">10. Privacy and Data Protection</h2>

<p><strong>10.1</strong> For your account, contact, and billing data, we act as data controller under the LGPD; our <a href="/privacy">Privacy Policy</a> explains that processing and your rights, and our data protection officer (encarregado) is identified in Section 21.</p>

<p><strong>10.2</strong> For Comment Data, you are the controller and we are the operator (processor), under the <a href="/dpa">DPA</a>, which forms part of these Terms. The DPA includes the sensitive-data and minors safeguards, the comment-data minimization measures, the prohibition on model training, and the international transfer mechanisms required by the LGPD.</p>

<p><strong>10.3</strong> We retain statutory connection and application-access logs for 6 months under Articles 13 and 15 of the Marco Civil da Internet, kept segregated and under secrecy; these logs and the Moderation Outcome Data described in Section 4.2 are the only records we retain.</p>

<h2 id="s11">11. Intellectual Property</h2>

<p><strong>11.1</strong> We own the Service, including its software, design, and documentation, and all improvements. These Terms grant you a limited, non-exclusive, non-transferable, revocable right to use the Service while your account is active. No other rights are granted.</p>

<p><strong>11.2</strong> You retain all rights in your channel and content. Comment authors retain whatever rights they have in their comments. We claim no ownership over Comment Data.</p>

<p><strong>11.3</strong> If you give us feedback or suggestions, you grant us a perpetual, royalty-free license to use them without obligation to you.</p>

<h2 id="s12">12. Third-Party Services and Platform Dependency</h2>

<p><strong>12.1</strong> The Service depends on third parties, including YouTube, Google, and our payment and hosting providers. Those third parties may change, suspend, or discontinue their services, APIs, or terms at any time, and may suspend your access to them independently of us.</p>

<p><strong>12.2</strong> We are not liable for acts, omissions, changes, or failures of third-party services. If a third-party change materially prevents us from providing the Service, any refund is governed by Section 7.</p>

<h2 id="s13">13. Service Availability, Changes and Suspension</h2>

<p><strong>13.1</strong> We provide the Service on a best-efforts basis and do not guarantee uninterrupted or error-free operation. Planned maintenance will be announced in advance where feasible.</p>

<p><strong>13.2</strong> We may modify the Service's features, provided we do not reduce the core functionality you purchased without offering you the option to cancel your account; refunds on cancellation are governed by Section 7.</p>

<p><strong>13.3</strong> We may suspend or restrict your access immediately if: (a) you breach these Terms; (b) required by law, court order, or authority; (c) your use poses a security risk or may harm third parties; or (d) your payment fails or is reversed. Where lawful, we will notify you and, for remediable breaches, give a reasonable cure period before termination.</p>

<h2 id="s14">14. Warranty Disclaimer</h2>

<p><strong class="highlight">14.1 TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE IS PROVIDED AS IS AND AS AVAILABLE, WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY OF AUTOMATED CLASSIFICATION, AND NON-INFRINGEMENT.</strong></p>

<p><strong class="highlight">14.2 IF YOU ARE A CONSUMER, THIS DISCLAIMER DOES NOT EXCLUDE OR LIMIT THE LEGAL GUARANTEE AND OTHER RIGHTS THAT CANNOT BE WAIVED UNDER ARTICLES 14, 24, 26, AND 51 OF THE CDC, WHICH PREVAIL OVER THIS CLAUSE.</strong></p>

<h2 id="s15">15. Limitation of Liability</h2>

<p><strong class="highlight">15.1 TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW: (A) OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE SHALL NOT EXCEED THE AMOUNTS YOU PAID FOR THE SERVICE IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR, IF GREATER AND ONLY WHERE MANDATORY LAW SO PROVIDES, THE MINIMUM AMOUNT THAT MANDATORY LAW REQUIRES US TO PAY; AND (B) WE SHALL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, LOSS OF PROFITS, REVENUE, DATA, GOODWILL, OR CHANNEL MONETIZATION, EVEN IF ADVISED OF THEIR POSSIBILITY.</strong></p>

<p><strong class="highlight">15.2 NOTHING IN THESE TERMS EXCLUDES OR LIMITS LIABILITY THAT CANNOT LAWFULLY BE EXCLUDED OR LIMITED, INCLUDING LIABILITY FOR WILLFUL MISCONDUCT (DOLO), FOR MORAL DAMAGES (DANOS MORAIS), UNDER THE LGPD, AND, WHERE YOU ARE A CONSUMER, LIABILITY THAT THE CDC RENDERS NON-WAIVABLE. IN THOSE CASES, THE LIMITATION ABOVE APPLIES ONLY TO THE EXTENT PERMITTED.</strong></p>

<h2 id="s16">16. Indemnification</h2>

<p><strong>16.1</strong> You shall indemnify, defend, and hold us harmless from claims, damages, fines, and expenses (including reasonable attorneys' fees) arising from: (a) your breach of these Terms; (b) your unlawful use of the Service; (c) your moderation instructions, configurations, and their effects on your channel or on comment authors; and (d) your violation of third-party rights or of the YouTube Terms of Service.</p>

<p><strong>16.2</strong> This indemnification does not apply to the extent a claim results from our breach of these Terms, our willful misconduct, or our violation of applicable law, and it is subject to the limits of Section 15.</p>

<h2 id="s17">17. Term and Termination</h2>

<p><strong>17.1</strong> These Terms take effect on acceptance and remain in force while you use the Service. You may terminate at any time by closing your account; Credits are handled as set out in Section 7.</p>

<p><strong>17.2</strong> We may terminate for convenience with 30 days' prior notice; refunds are governed by Section 7. We may terminate immediately for material breach not cured within a reasonable period after notice, or where Section 13.3 applies.</p>

<p><strong>17.3</strong> Upon termination: your access ends; Comment Data is handled as set out in the DPA (deletion within 30 days, except statutory logs); Sections 11, 14, 15, 16, 19, and 20 survive.</p>

<h2 id="s18">18. Changes to These Terms</h2>

<p><strong>18.1</strong> We may update these Terms with at least 30 days' prior notice, sent by e-mail and displayed prominently in the Service, indicating the changes and their effective date. No change will have retroactive effect or reduce rights you have already paid for.</p>

<p><strong>18.2</strong> If you do not agree with a change, you may terminate before its effective date; refunds are governed by Section 7. Continued use after the effective date constitutes acceptance.</p>

<h2 id="s19">19. Governing Law, Forum and Dispute Resolution</h2>

<p><strong>19.1</strong> These Terms are governed by the laws of Brazil.</p>

<p><strong>19.2</strong> If you are a Consumer, any dispute may be brought, at your choice, before the courts of your domicile, as provided by Article 101, I, of the CDC. Nothing in these Terms compels you to arbitrate; arbitration may be used only if you initiate it or expressly agree to it in writing after the dispute arises, in accordance with Article 51, VII, of the CDC and Article 4, §2, of Law no 9.307/1996.</p>

<p><strong>19.3</strong> If you use the Service as a business (not as a Consumer), the courts of the judicial district of our registered seat in Brazil shall have exclusive jurisdiction, except where applicable law provides otherwise. A business user may instead opt for arbitration seated in Brazil only through a specific, separately executed arbitration clause.</p>

<h2 id="s20">20. General Provisions</h2>

<p><strong>20.1</strong> These Terms are published in English. A Portuguese version will be made available and, once published, will prevail for users domiciled in Brazil. Both versions will then be equally available before acceptance.</p>

<p><strong>20.2</strong> If any provision is held invalid or unenforceable (including under Article 51 of the CDC), it shall be enforced to the maximum extent permissible and the remainder stays in force.</p>

<p><strong>20.3</strong> Failure to enforce a provision is not a waiver. You may not assign these Terms without our consent; we may assign them to an affiliate or successor of the Service, with notice to you and no reduction of your rights.</p>

<p><strong>20.4</strong> Notices to you are sent to your registered e-mail or displayed in the Service. Notices to us must be sent to the e-mail in Section 21. Notices are deemed received on the next business day after sending.</p>

<p><strong>20.5</strong> Neither party is liable for failure to perform due to events beyond its reasonable control, including failures of YouTube, Google, or telecommunications infrastructure, provided the affected party notifies the other and resumes performance as soon as feasible.</p>

<h2 id="s21">21. Contact and Data Protection Officer</h2>

<p>Service operator: [legal name], sole proprietorship, CNPJ [number], registered address [address], Brazil.</p>

<p>Support and notices: <a href="mailto:contact@marketingprowess.simplelogin.com">contact@marketingprowess.simplelogin.com</a>.</p>

<p>Data Protection Officer (Encarregado de Proteção de Dados): Andrew Philip Weilbacher, <a href="mailto:contact@marketingprowess.simplelogin.com">contact@marketingprowess.simplelogin.com</a>.</p>
