import Link from "next/link";
import PublicNav from "@/components/PublicNav";

export const metadata = {
  title: "Terms of Service — BloomIQ",
  description: "BloomIQ Terms of Service.",
};

/**
 * /terms — BloomIQ Terms of Service.
 *
 * IMPORTANT: This is a reasonable starting template assembled from common SaaS
 * boilerplate. It is NOT legal advice and has not been reviewed by counsel.
 * Before BloomIQ takes its first paying customer (school or individual) you
 * should run this past a lawyer in your home jurisdiction (India, given
 * Razorpay + INR pricing) to localise it properly. In particular:
 *   - Indian Contract Act, IT Act 2000, IT Rules 2011 / 2021 (intermediary)
 *   - Consumer Protection Act 2019 (refunds, dispute resolution)
 *   - DPDP Act 2023 (data protection — see /privacy)
 *   - GST registration thresholds and invoicing rules
 *
 * The "BloomIQ" entity name below should be replaced with your actual
 * registered legal entity (e.g. "BloomIQ Technologies Pvt. Ltd.") and the
 * registered address added once incorporated. Update the contact email to
 * your real support address before going live.
 */
export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white">
      <header className="border-b border-slate-200/60 bg-white/70 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl">🌱</span>
            <span className="font-bold tracking-tight">BloomIQ</span>
          </Link>
          <PublicNav />
        </div>
      </header>

      <article className="max-w-3xl mx-auto px-6 py-12 prose prose-slate">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-slate-500 mb-8">Last updated: 30 April 2026</p>

        <p>
          These Terms of Service (&quot;Terms&quot;) govern your access to and use of the
          BloomIQ platform (the &quot;Service&quot;), operated by BloomIQ (&quot;we&quot;, &quot;us&quot;, or
          &quot;our&quot;). By creating an account, signing in, or otherwise using the
          Service, you agree to be bound by these Terms and our{" "}
          <Link href="/privacy" className="text-emerald-700 font-semibold">Privacy Policy</Link>.
          If you do not agree, do not use the Service.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">1. Eligibility and accounts</h2>
        <p>
          You may use the Service only if you can form a binding contract with BloomIQ.
          If you are under 18, you may use the Service only with the consent and
          supervision of a parent, legal guardian, or authorised teacher who agrees
          to these Terms on your behalf. School accounts created by an Admin Head
          (Principal) on behalf of their institution remain the responsibility of
          the institution. You are responsible for keeping your login credentials
          confidential and for all activity under your account.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">2. Subscriptions, payments, and refunds</h2>
        <p>
          Some features require a paid subscription. Pricing is shown on our{" "}
          <Link href="/pricing" className="text-emerald-700 font-semibold">Pricing page</Link>
          {" "}and is processed by Razorpay. You authorise us (via Razorpay) to charge
          your chosen payment method. Subscriptions renew automatically at the end
          of each billing cycle unless cancelled before renewal. You may cancel at
          any time and will retain access until the end of the current billing
          period. We do not provide refunds for partially used billing periods,
          except where required by applicable consumer protection law.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">3. User-uploaded content</h2>
        <p>
          BloomIQ lets you upload content — notes, images of textbooks, past exam
          papers, student responses, and similar material — for the purpose of
          generating quizzes, analysing performance, and other educational
          functions. By uploading any content (&quot;User Content&quot;) you represent and
          warrant that you have all necessary rights, licences, and consents to do
          so, and that the User Content does not infringe any third-party
          intellectual property, privacy, or other rights, and does not violate
          any applicable law. You retain ownership of your User Content.
        </p>
        <p>
          You grant BloomIQ a worldwide, non-exclusive, royalty-free licence to
          host, store, process, transmit, and display your User Content solely for
          the purpose of operating, improving, and supporting the Service for you.
          You are solely responsible for the legality of any User Content you
          upload, including past examination papers and copyrighted material;
          BloomIQ is not the publisher of and does not endorse or verify User
          Content.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">4. AI-generated output</h2>
        <p>
          The Service uses third-party large language models (currently Google
          Gemini and Groq-hosted models) to generate questions, explanations,
          analyses, and study suggestions (&quot;AI Output&quot;). AI Output may contain
          inaccuracies, omissions, or unsuitable material. You should review all
          AI Output before relying on it, especially before using it in classroom
          assessment or examination contexts. BloomIQ does not warrant the
          accuracy, completeness, or fitness for any particular purpose of any
          AI Output. You are responsible for verifying AI Output before acting
          on it.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">5. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Use the Service to upload content that is illegal, infringing, harmful, harassing, defamatory, or that depicts a minor in a sexualised manner.</li>
          <li>Reverse-engineer, decompile, or attempt to extract the source code of the Service or the underlying AI models.</li>
          <li>Scrape, crawl, or use automated tools to extract data from the Service except where explicitly permitted via documented APIs.</li>
          <li>Resell, sublicense, or redistribute access to the Service without our prior written consent.</li>
          <li>Use the Service to develop or train competing products.</li>
          <li>Share login credentials between people, except as part of an institutional Admin-Head-managed account.</li>
        </ul>

        <h2 className="text-xl font-bold mt-8 mb-3">6. Service availability and changes</h2>
        <p>
          We aim to keep the Service available but do not guarantee uninterrupted
          access. We may add, modify, or remove features at any time. We will give
          reasonable advance notice for material changes that affect paying
          subscribers.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">7. Termination</h2>
        <p>
          You may stop using the Service at any time by signing out and (if
          applicable) cancelling your subscription. We may suspend or terminate
          your account if you breach these Terms or use the Service in a way that
          puts other users or our infrastructure at risk. On termination your
          right to use the Service ends; we may retain backups for a reasonable
          period as described in our Privacy Policy.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">8. Intellectual property</h2>
        <p>
          The Service, including all software, designs, logos, and our own
          content, is owned by BloomIQ or our licensors and is protected by
          copyright, trademark, and other laws. We grant you a limited,
          non-exclusive, non-transferable licence to use the Service in
          accordance with these Terms.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">9. Disclaimers</h2>
        <p>
          THE SERVICE IS PROVIDED ON AN &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; BASIS, WITHOUT
          WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF
          MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT,
          EXCEPT AS REQUIRED BY APPLICABLE LAW. THE SERVICE IS NOT A SUBSTITUTE
          FOR PROFESSIONAL EDUCATIONAL, MEDICAL, LEGAL, OR FINANCIAL ADVICE.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">10. Limitation of liability</h2>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, BLOOMIQ&apos;S AGGREGATE LIABILITY
          ARISING OUT OF OR RELATED TO THE SERVICE WILL NOT EXCEED THE GREATER
          OF (A) THE AMOUNTS PAID BY YOU TO US IN THE TWELVE MONTHS PRECEDING
          THE CLAIM, OR (B) ₹1,000 INR. IN NO EVENT WILL BLOOMIQ BE LIABLE FOR
          INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">11. Governing law and disputes</h2>
        <p>
          These Terms are governed by the laws of India. Any dispute arising out
          of or in connection with these Terms shall be subject to the exclusive
          jurisdiction of the courts located in [your city], India.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">12. Changes to these Terms</h2>
        <p>
          We may update these Terms from time to time. Material changes will be
          notified via email or in-product banner at least 14 days before they
          take effect. Continued use of the Service after the effective date
          constitutes acceptance of the updated Terms.
        </p>

        <h2 className="text-xl font-bold mt-8 mb-3">13. Contact</h2>
        <p>
          Questions about these Terms? Email{" "}
          <a href="mailto:hello@bloomiq.app" className="text-emerald-700 font-semibold">hello@bloomiq.app</a>.
        </p>

        <p className="text-xs text-slate-500 italic mt-12 border-t border-slate-200 pt-6">
          Note: These Terms are a working draft assembled from common SaaS
          boilerplate. Before BloomIQ&apos;s first paying customer, this document
          should be reviewed by qualified legal counsel familiar with Indian
          contract law, the IT Act 2000, the Consumer Protection Act 2019, and
          the DPDP Act 2023.
        </p>
      </article>

      <footer className="max-w-6xl mx-auto px-6 py-8 text-center text-sm text-slate-500 border-t border-slate-200">
        © BloomIQ ·{" "}
        <Link href="/terms" className="hover:text-emerald-700">Terms</Link> ·{" "}
        <Link href="/privacy" className="hover:text-emerald-700">Privacy</Link>
      </footer>
    </main>
  );
}
