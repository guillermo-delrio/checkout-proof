# Checkout Proof demo video, draft 3 (tools/video)

Narration: Kokoro-82M (Apache-2.0), voice af_heart; synthetic voice, disclosed on the end card. Captions are these
words. Audience: developers and PayPal judges (`review.py --audience developers`, plus the pitch reviewer in
`reviews/pitch/`). Target 2:30 to 2:50 (rule: under 3:00, shows the project working, no third-party trademarks or
copyrighted music: no music at all, no logos but PayPal's own sandbox pages and the site itself).

Draft 3 (25 Oct) rewrites the structure after the owner watched draft 2: say what Checkout Proof is before any
detail, product voice instead of a build diary, no hand-edit story, and one flaw only, explained in full.

Every number is traced in `../devpost.md` (sources block) and `web/public/data`. Pages: the live site,
https://checkout-proof-149219545146.us-central1.run.app. The live run in s06 is a replay of saved job eaa8a827
(22 Oct, 78 s, both FAIL): capture spends no live run.

## title Opening card
Card: "Checkout Proof" / "An AI upgrades PayPal checkouts. The PayPal sandbox proves it."

## s01a The problem
> Many online shops still take payments through PayPal's older integrations. Upgrading is risky, because a checkout can break without any error and quietly lose money.

## s01b What Checkout Proof is
> Checkout Proof upgrades that old code and proves the new checkout still takes money correctly. Claude, an AI model from Anthropic, writes the upgrade, following one money rule. Every paid order needs exactly one finished PayPal payment, for the right amount, in the right currency. Checkout Proof then makes test payments in the PayPal sandbox, where no real money moves. Some tests copy real problems, like a declined payment. Plain code, not AI, checks the rule against PayPal's records.

## s02a A bug in the old code
> The first shop tested is expressCart, a free, open-source online shop. Even before any upgrade, the tests find money bugs in its code. In one, a buyer starts a 480 euro order, then cancels on the PayPal page. Back in the shop, the buyer removes most of the items and pays 85 euros.

## s02b The receipt
> PayPal took 85 euros. But the shop marked the full 480 euro order as paid, so it would ship 480 euros of goods for 85. After Claude's upgrade, the same test passes. The bug is gone.

## s03 Results
> Checkout Proof also tested a second open-source shop, a small clothing store. Across the two original shops, it found nine money bugs. After Claude's upgrades, all nine are fixed, and every test passes on both shops.

## s04 Claude's own bug
> Checkout Proof also catches bugs that Claude writes itself. In a separate test on the clothing store, Claude got only a plain request to upgrade the code, with no money rule. The upgraded shop then accepted just 1 euro for a 62 euro order. The original shop never had this bug. This is why every upgrade gets tested, not trusted.

## s05 Fixed from the evidence
> Checkout Proof sent the failing tests and PayPal's records back to Claude, still with no money rule. In under a minute and a half, Claude found the causes and fixed the code. On the next test run, Claude's own bug was gone.

## s06a Watch the original lose money
> You can check this yourself. On the Checkout Proof website, one button runs two tests against the original clothing store, live. It still has its old bugs. So here, a red failed test is the result we want.

## s06b Red, live
> About a minute later, both tests fail. One order is paid twice, and one 62 euro order is paid with 62 Mexican pesos. Both break the money rule.

## s07 Try it
> On the live site, you can also scan any public GitHub repo for old PayPal code, or re-run the tests on the upgraded clothing store and watch them pass. Every upgrade faces the same money rule. Don't just upgrade your PayPal checkout. Prove that it still takes the money right.

## end End card
Card: "Checkout Proof", the live URL, "Everything runs in the PayPal sandbox. No real money moves.",
"Narration: synthetic voice (Kokoro TTS)".
