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

<p>This Policy provides the information required by Article 9 of the Brazilian General Data Protection Law (Lei no 13.709/2018 — LGPD) in a clear, adequate and ostensible manner, and includes the disclosures required by the YouTube API Services Terms of Service.</p>

<h2 id="s1">1. Who We Are and What This Policy Covers</h2>
<p><strong>1.1</strong> Moderaty is a YouTube comment moderation service operated by [legal name], a sole proprietorship registered in Brazil, CNPJ [number], registered address [address] (Moderaty, we, us). For the personal data described in this Policy, Moderaty is the data controller under the LGPD.</p>
<p><strong>1.2</strong> This Policy covers personal data of our users (YouTube channel owners and their authorized team members) and of people who contact us. It also explains, for transparency, how comment data flows through the Service — but note that for comment data we act as processor on behalf of the channel owner, who is the controller (Section 3).</p>
<p><strong>1.3</strong> Our Data Protection Officer (Encarregado de Proteção de Dados) is Andrew Philip Weilbacher, reachable at <a href="mailto:contact@marketingprowess.simplelogin.com">contact@marketingprowess.simplelogin.com</a>. The DPO acts with independence and technical autonomy, in accordance with ANPD Resolution CD/ANPD no 18/2024.</p>
<p><strong>1.4</strong> <strong class="highlight">PROVIDING CERTAIN PERSONAL DATA (ACCOUNT AND BILLING INFORMATION) IS A CONDITION FOR USING THE SERVICE, BECAUSE WITHOUT IT WE CANNOT CREATE YOUR ACCOUNT, CONNECT YOUR CHANNEL, OR PROCESS PAYMENTS. WHERE THAT IS THE CASE, THIS FACT IS DISCLOSED HERE WITH PROMINENCE, AS REQUIRED BY ARTICLE 9, §3, OF THE LGPD. YOUR RIGHTS AND HOW TO EXERCISE THEM ARE IN SECTION 10.</strong></p>

<h2 id="s2">2. The Data We Process, and Why</h2>
<p>The table below lists each processing activity, the data involved, the specific purpose, the legal basis under the LGPD, and the retention period. We do not sell personal data, we do not use personal data for advertising profiling, and we do not train machine-learning models on personal data.</p>
<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>Activity and data</th>
				<th>Specific purpose</th>
				<th>Legal basis (LGPD)</th>
				<th>Retention</th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<td>Account registration: name, e-mail, Google account ID, channel ID(s)</td>
				<td>Create and manage your account; connect your YouTube channel via OAuth; deliver the Service</td>
				<td>Contract performance (Art. 7, V)</td>
				<td>Duration of the account; deleted within 30 days of account closure, except legal-retention items below</td>
			</tr>
			<tr>
				<td>Billing: name, e-mail, purchase history, tax ID (if provided). Card data is processed by Stripe; we never see or store full card numbers</td>
				<td>Process payments, issue invoices, prevent chargeback fraud</td>
				<td>Contract performance (Art. 7, V); legal obligation (Art. 7, II — tax and accounting records)</td>
				<td>Invoices and tax records: 5 years or the period required by Brazilian tax law</td>
			</tr>
			<tr>
				<td>Service operation: moderation configuration, moderation outcome records (comment ID reference, comment text truncated to 500 characters, verdict, action, timestamp — no author identifiers)</td>
				<td>Execute your moderation instructions; show your activity history</td>
				<td>Contract performance (Art. 7, V)</td>
				<td>Duration of the subscription; deleted within 30 days of termination</td>
			</tr>
			<tr>
				<td>Connection and application-access logs: IP, timestamps, session records</td>
				<td>Comply with Articles 13 and 15 of the Marco Civil da Internet; security and abuse prevention</td>
				<td>Legal obligation (Art. 7, II)</td>
				<td>6 months, segregated and under secrecy, then automatically deleted</td>
			</tr>
			<tr>
				<td>Support: e-mail address and content of your messages</td>
				<td>Respond to your requests; keep a record of our correspondence</td>
				<td>Contract performance (Art. 7, V); legitimate interest (Art. 7, IX)</td>
				<td>Up to 2 years after the last interaction</td>
			</tr>
			<tr>
				<td>Security and abuse prevention: access patterns, error logs</td>
				<td>Protect the Service, detect and prevent fraud and attacks</td>
				<td>Legitimate interest (Art. 7, IX) — balancing test documented; you may object (Section 10)</td>
				<td>Up to 12 months</td>
			</tr>
			<tr>
				<td>Service communications: e-mail</td>
				<td>Send operational notices (Terms changes, billing, security alerts). Marketing messages only with your opt-in consent, with unsubscribe in every message</td>
				<td>Legal obligation / legitimate interest for operational notices; consent (Art. 7, I) for marketing</td>
				<td>Until account closure or consent withdrawal</td>
			</tr>
		</tbody>
	</table>
</div>

<h2 id="s3">3. Comment Data: We Are the Processor, Not the Controller</h2>
<p><strong>3.1</strong> Comments on your channel contain personal data of third parties (the comment authors). For that data, the channel owner is the controller and Moderaty is the operator (processor), under the <a href="/dpa">Data Processing Agreement (DPA)</a> that forms part of our <a href="/terms">Terms of Service</a>.</p>
<p><strong>3.2</strong> Comment text and author identifiers are retrieved via the YouTube API Services, classified, and acted upon according to the channel owner's configuration. We store the comment text (truncated to 500 characters) together with the moderation outcome record, so your review queue and audit history work. Comment author identifiers (display name and author channel ID) are processed in memory at decision time and are never stored from comments. The one exception is identifiers you enter yourself: a blocked-user rule stores the channel ID you type as your own configuration, matched against incoming comments in memory only. We do not build profiles of comment authors, we do not perform author-level behavioral analysis, and we do not train models on comment data.</p>
<p><strong>3.3</strong> Comments may incidentally contain sensitive personal data (for example, hate speech referencing race, religion, or political opinion) and may be authored by minors, whose age we cannot identify. We therefore treat all comment data to the highest protection standard, consistent with the best-interest principle of Article 14 of the LGPD and the ECA Digital (Law no 15.211/2025). The lawful basis for this processing belongs to the channel owner as controller and flows down to us through the DPA.</p>
<p><strong>3.4</strong> If you are a comment author and want to exercise rights over a comment, please contact the channel owner (the controller). If you contact us directly, we will forward your request to the channel owner where possible, within 5 business days. Comment author identifiers are not persistently stored or linked in our database (Section 3.2); however, stored comment records include the YouTube comment ID, from which the author could in principle be re-identified via YouTube while the channel owner's access remains active — one more reason your request belongs with the channel owner.</p>

<h2 id="s4">4. YouTube API Services Disclosures</h2>
<p><strong>4.1</strong> Moderaty uses YouTube API Services to retrieve comments and execute moderation actions on channels our users authorize. By using the Service, you agree to be bound by the YouTube Terms of Service at <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">https://www.youtube.com/t/terms</a>.</p>
<p><strong>4.2</strong> Information received from YouTube API Services is used only to provide the moderation features described in this Policy, in accordance with the Google Privacy Policy at <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">https://policies.google.com/privacy</a>.</p>
<p><strong>4.3</strong> You can revoke Moderaty's access to your YouTube data at any time via the Google security settings page at <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noreferrer">https://security.google.com/settings/security/permissions</a>. After revocation, we can no longer access the affected channel; author identifiers were never stored, and moderation outcome records (including stored comment text) are handled as described in Section 2.</p>
<p><strong>4.4</strong> YouTube and Google operate under their own privacy policies, which we do not control and for which we are not responsible.</p>

<h2 id="s5">5. Sharing and Recipients</h2>
<p>We share personal data only with:</p>
<ul>
	<li>(a) Infrastructure and service providers acting as our sub-processors or processors under contract, each limited to what it needs to perform its function: Netlify, Inc. (application hosting and delivery — United States); Turso / ChiselStrike, Inc. (database hosting — United States, with edge replicas only in regions we disclose and record); OpenAI, LLC (transient comment classification only, no retention, no model training — United States); Stripe, Inc. (payment processing — United States); and [e-mail delivery provider] (transactional e-mail);</li>
	<li>(b) Google/YouTube, as the platform through which the Service operates and as an independent controller of its own processing;</li>
	<li>(c) Public authorities, courts, or regulators, only when required by law, court order, or to protect our rights, users, or third parties, and always limited to what is legally required; and</li>
	<li>(d) A successor entity in the event of a merger, acquisition, or sale of the Service, subject to this Policy and with prior notice to you.</li>
</ul>
<p>We do not sell, rent, or trade personal data. An up-to-date list of sub-processors is maintained in the <a href="/dpa">DPA (Annex III)</a>, and we give at least 15 days' notice of changes, during which you may object on reasonable data protection grounds.</p>

<h2 id="s6">6. International Data Transfers</h2>
<p><strong>6.1</strong> Some recipients above are located outside Brazil (including the United States). Transfers of personal data abroad occur only under a valid mechanism of Article 33 of the LGPD.</p>
<p><strong>6.2</strong> Where the mechanism is standard contractual clauses, we use the clauses approved by ANPD Resolution CD/ANPD no 19/2024 — clauses from other jurisdictions (such as EU SCCs) are not used as a substitute. Where a transfer relies on another Article 33 mechanism (for example, an ANPD adequacy decision), that mechanism is recorded in our transfer records, available upon request.</p>
<p><strong>6.3</strong> As of the effective date of this Policy, international transfer recipients are: Google LLC (YouTube API Services), Netlify, Inc., OpenAI, LLC, Turso / ChiselStrike, Inc., and Stripe, Inc. (all United States). Database edge replicas, if enabled, operate only in regions recorded in Annex III of the DPA.</p>

<h2 id="s7">7. Retention and Deletion</h2>
<p><strong>7.1</strong> We keep personal data only for the periods stated in Section 2, after which it is deleted or irreversibly anonymized. Comment author identifiers are never persistently stored (Section 3.2); pseudonymized identifiers (such as hashed usernames) remain personal data and are likewise not retained. Comment text is retained only as part of moderation outcome records, for the periods stated in Section 2.</p>
<p><strong>7.2</strong> We may retain data beyond the stated periods only where required by law, court order, or for the regular exercise of rights in judicial, administrative, or arbitral proceedings (Art. 16 of the LGPD), restricted to that purpose.</p>

<h2 id="s8">8. Security</h2>
<p><strong>8.1</strong> We apply technical and organizational measures proportionate to the risk, including TLS encryption in transit, least-privilege access, multi-factor authentication for administrative access, managed secrets storage, environment isolation, and an incident response plan aligned with the 3-business-day ANPD notification deadline of Resolution CD/ANPD no 15/2024. Details are in Annex II of the DPA, available upon request.</p>
<p><strong>8.2</strong> No method of transmission or storage is completely secure. If an incident occurs that may entail relevant risk or harm to you, we will notify you and the ANPD within the legal deadline, with the information required by law and the measures taken.</p>

<h2 id="s9">9. Legitimate Interest Notice</h2>
<p>Where we rely on legitimate interest (security, abuse prevention, support records), we process only non-sensitive data strictly necessary for the specific purpose, we have documented a balancing test (LIA) in writing per the ANPD's 2024 Legitimate Interest Guidance, and we offer easy objection mechanisms. We never rely on legitimate interest for sensitive data, and we never use personal data to train AI models. You may request a summary of any balancing test from our DPO.</p>

<h2 id="s10">10. Your Rights</h2>
<p><strong>10.1</strong> Under Article 18 of the LGPD, you have the right to: (I) confirmation that we process your data; (II) access; (III) correction of incomplete, inaccurate, or outdated data; (IV) anonymization, blocking, or deletion of unnecessary, excessive, or unlawfully processed data; (V) portability, as regulated by the ANPD; (VI) deletion of data processed with consent; (VII) information about the entities with which we share data; (VIII) information about the option not to consent and its consequences; (IX) revocation of consent; and (X) opposition to processing based on legitimate interest, where the legal requirements are met.</p>
<p><strong>10.2</strong> To exercise any right, contact our DPO at <a href="mailto:contact@marketingprowess.simplelogin.com">contact@marketingprowess.simplelogin.com</a>. We respond within 15 days. We may need to verify your identity before acting — a proportionate security measure. Requests are free of charge. If we cannot fulfill a request (for example, because the data was already deleted or must be retained by law), we will explain why within the same period.</p>
<p><strong>10.3</strong> You may also lodge a complaint with the ANPD (Autoridade Nacional de Proteção de Dados) at <a href="https://www.gov.br/anpd/pt-br" target="_blank" rel="noreferrer">https://www.gov.br/anpd/pt-br</a>.</p>

<h2 id="s11">11. Children and Adolescents</h2>
<p><strong>11.1</strong> The Service is a professional tool directed exclusively at persons aged 18 or older and is not likely or foreseeably accessed by minors. We do not knowingly collect personal data directly from children or adolescents. If we learn that an account belongs to a minor, we will suspend and delete it.</p>
<p><strong>11.2</strong> For comment data that may relate to minors, see Section 3.3: we process all comment data to the highest standard because author age cannot be identified.</p>

<h2 id="s12">12. Cookies and Similar Technologies</h2>
<p><strong>12.1</strong> The Service uses only strictly necessary cookies (session authentication, security, preference storage). We do not use advertising or third-party tracking cookies. You can block cookies in your browser, but essential cookies are required for login and security features to work.</p>

<h2 id="s13">13. Changes to This Policy</h2>
<p><strong>13.1</strong> We may update this Policy with at least 30 days' prior notice, displayed prominently in the Service and sent by e-mail, with specific prominence given to any change in purpose, form, duration, controller identification, or sharing practices, as required by Article 8, §6, of the LGPD. Where processing is based on your consent and the change is incompatible with the original consent, you may revoke your consent before the change takes effect.</p>
<p><strong>13.2</strong> The current version is always available at <a href="/privacy">/privacy</a>, with its effective date and a change history.</p>

<h2 id="s14">14. Language and Governing Law</h2>
<p><strong>14.1</strong> This Policy is published in English. A Portuguese version will be made available and, once published, will prevail for data subjects located in Brazil. This Policy is governed by Brazilian law, in particular the LGPD, the Marco Civil da Internet (Law no 12.965/2014), and the ECA Digital (Law no 15.211/2025).</p>
