import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { KINDS, createFetchContext, runAutomatedCheck, sanitizeCriterion } from './checks.js';
import { assertFetchable, collectRepoEvidence, resolveAgainst } from './evidence.js';
import { scanForInjection } from './injection.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const STATUS = {
  awaiting_agreement: 'Waiting for the freelancer to accept the criteria',
  awaiting_funding: 'Waiting for the client to fund the hold',
  funded: 'Money on hold. Waiting for the work',
  in_review: 'Verdict is reviewing the work',
  changes_requested: 'Changes requested. Money still on hold',
  escalated: 'Waiting for a human decision',
  releasing: 'Releasing payment',
  released: 'Paid',
  settlement_failed: 'Payment release needs a retry',
  cancelled: 'Cancelled. The client was not charged',
};

const shortId = () => randomBytes(5).toString('hex');
const token = () => randomBytes(18).toString('base64url');
const now = () => new Date().toISOString();
const toCents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => (c / 100).toFixed(2);

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createDealService({ store, paypal, ai, config }) {
  const busy = new Set();
  const reviews = new Set();

  function event(deal, actor, type, message, ref = null) {
    deal.events.push({ at: now(), actor, type, message, ref });
  }

  function roleFor(deal, tok) {
    if (safeEqual(tok, deal.tokens.client)) return 'client';
    if (safeEqual(tok, deal.tokens.freelancer)) return 'freelancer';
    return 'viewer';
  }

  function require(deal, role, need, statuses) {
    if (role !== need) throw new HttpError(403, `Only the ${need} can do this.`);
    if (statuses && !statuses.includes(deal.status)) throw new HttpError(409, `Not possible while the deal is "${STATUS[deal.status]}".`);
  }

  async function withLock(deal, fn) {
    if (busy.has(deal.id)) throw new HttpError(409, 'Another action on this deal is in progress. Try again in a moment.');
    busy.add(deal.id);
    try {
      return await fn();
    } finally {
      busy.delete(deal.id);
    }
  }

  function actionsFor(deal, role) {
    const a = [];
    const subs = deal.submissions;
    const last = subs[subs.length - 1];
    if (role === 'client') {
      if (deal.status === 'awaiting_funding') a.push('fund');
      if (['awaiting_agreement', 'awaiting_funding'].includes(deal.status) || (deal.status === 'funded' && !subs.length)) a.push('cancel');
      if (deal.status === 'escalated') a.push('resolve');
      if (deal.status === 'settlement_failed') a.push('retry_settlement');
    }
    if (role === 'freelancer') {
      if (deal.status === 'awaiting_agreement') a.push('accept');
      if (['funded', 'changes_requested'].includes(deal.status) && subs.length < config.maxAttempts) a.push('submit');
      if (deal.status === 'changes_requested' && last?.verdict?.decision === 'changes_requested') a.push('escalate');
    }
    return a;
  }

  function view(deal, role) {
    const { tokens, ...rest } = deal;
    return {
      ...rest,
      role,
      statusLabel: STATUS[deal.status],
      actions: actionsFor(deal, role),
      attemptsLeft: Math.max(config.maxAttempts - deal.submissions.length, 0),
      maxAttempts: config.maxAttempts,
      ...(role === 'client' ? { inviteToken: tokens.freelancer } : {}),
    };
  }

  function validateCriteria(list) {
    if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one acceptance criterion.');
    if (list.length > 12) throw new HttpError(400, 'Use at most 12 criteria.');
    return list.map((c, i) => sanitizeCriterion(c, i));
  }

  // ------------------------------------------------------------------ create & agree

  async function createDeal(input) {
    const title = String(input.title || '').trim().slice(0, 120);
    const description = String(input.description || '').trim().slice(0, 6000);
    const amount = Number(input.amount);
    const freelancerEmail = String(input.freelancerEmail || '').trim().toLowerCase();
    if (!title) throw new HttpError(400, 'Give the job a title.');
    if (description.length < 20) throw new HttpError(400, 'Describe the job in at least a sentence or two.');
    if (!Number.isFinite(amount) || amount < 1 || amount > 10000) throw new HttpError(400, 'Amount must be between $1 and $10,000.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(freelancerEmail)) throw new HttpError(400, "Enter the freelancer's PayPal email address.");

    const criteria = validateCriteria(input.criteria);
    const deal = {
      id: shortId(),
      title,
      description,
      amount: amount.toFixed(2),
      currency: config.paypal.currency,
      platformFeePercent: config.platformFeePercent,
      client: { name: String(input.clientName || 'Client').slice(0, 80) },
      freelancer: { name: String(input.freelancerName || 'Freelancer').slice(0, 80), paypalEmail: freelancerEmail },
      criteria,
      criteriaSource: input.criteriaSource === 'anthropic' ? 'anthropic' : input.criteriaSource === 'heuristic' ? 'heuristic' : 'edited',
      status: 'awaiting_agreement',
      tokens: { client: token(), freelancer: token() },
      paypal: { mode: config.paypal.mode },
      submissions: [],
      events: [],
      createdAt: now(),
    };
    event(deal, 'client', 'created', `${deal.client.name} proposed a $${deal.amount} job with ${criteria.length} acceptance criteria.`);
    store.putDeal(deal);
    return deal;
  }

  async function accept(deal, role) {
    require(deal, role, 'freelancer', ['awaiting_agreement']);
    deal.status = 'awaiting_funding';
    deal.agreedAt = now();
    event(deal, 'freelancer', 'accepted', `${deal.freelancer.name} accepted the acceptance criteria. The contract is locked.`);
    return store.putDeal(deal);
  }

  // ------------------------------------------------------------------ fund (PayPal hold)

  async function createOrder(deal, role) {
    require(deal, role, 'client', ['awaiting_funding']);
    return withLock(deal, async () => {
      const order = await paypal.createAuthorizeOrder({ dealId: deal.id, title: deal.title, amount: deal.amount });
      deal.paypal.orderId = order.orderId;
      event(deal, 'paypal', 'order_created', `PayPal order created with intent AUTHORIZE for $${deal.amount}.`, { orderId: order.orderId, debugId: order.debugId });
      store.putDeal(deal);
      return order;
    });
  }

  async function authorize(deal, role, orderId) {
    require(deal, role, 'client', ['awaiting_funding']);
    if (!orderId || orderId !== deal.paypal.orderId) throw new HttpError(400, 'This PayPal order does not belong to this deal.');
    return withLock(deal, async () => {
      const auth = await paypal.authorizeOrder(orderId);
      Object.assign(deal.paypal, {
        authorizationId: auth.authorizationId,
        authorizationStatus: auth.status,
        authorizationExpiresAt: auth.expiresAt,
        payerEmail: auth.payerEmail,
      });
      deal.status = 'funded';
      deal.fundedAt = now();
      event(deal, 'paypal', 'authorized', `$${deal.amount} is on hold in the client's PayPal account. Nothing has been charged yet.`, {
        authorizationId: auth.authorizationId,
        expiresAt: auth.expiresAt,
        debugId: auth.debugId,
      });
      return store.putDeal(deal);
    });
  }

  // ------------------------------------------------------------------ submit & review

  async function submit(deal, role, input) {
    require(deal, role, 'freelancer', ['funded', 'changes_requested']);
    if (deal.submissions.length >= config.maxAttempts) throw new HttpError(409, 'No review attempts left. Ask for a human review.');
    const url = String(input.url || '').trim();
    const repoUrl = String(input.repoUrl || '').trim();
    await assertFetchable(url, { allowPrivateUrls: config.allowPrivateUrls }).catch((e) => {
      throw new HttpError(400, e.message);
    });
    if (repoUrl && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/i.test(repoUrl)) throw new HttpError(400, 'Repository must be a public https://github.com/owner/repo link.');

    const submission = {
      id: randomUUID(),
      n: deal.submissions.length + 1,
      url,
      repoUrl: repoUrl || null,
      note: String(input.note || '').slice(0, 1000),
      createdAt: now(),
      verdict: {
        status: 'running',
        startedAt: now(),
        aiProvider: ai.provider,
        aiModel: ai.model,
        checks: deal.criteria.map((c) => ({
          criterionId: c.id,
          title: c.title,
          kind: c.kind,
          required: c.required,
          method: KINDS[c.kind].automated ? 'automated' : 'ai',
          state: 'pending',
        })),
      },
    };
    deal.submissions.push(submission);
    deal.status = 'in_review';
    event(deal, 'freelancer', 'submitted', `${deal.freelancer.name} submitted attempt ${submission.n}: ${url}`);
    store.putDeal(deal);

    const run = runReview(deal.id, submission.id).catch((err) => {
      const d = store.getDeal(deal.id);
      const s = d?.submissions.find((x) => x.id === submission.id);
      if (!d || !s) return;
      s.verdict.status = 'error';
      s.verdict.error = err.message;
      s.verdict.decision = 'escalate';
      s.verdict.decisionReason = 'The review could not finish, so a human needs to decide.';
      d.status = 'escalated';
      event(d, 'verdict', 'review_error', `Review failed: ${err.message}. Sent to a human.`);
      store.putDeal(d);
    });
    reviews.add(run);
    run.finally(() => reviews.delete(run));
    return deal;
  }

  async function runReview(dealId, submissionId) {
    const deal = store.getDeal(dealId);
    const sub = deal.submissions.find((s) => s.id === submissionId);
    const v = sub.verdict;
    const save = () => store.putDeal(deal);
    const setCheck = (id, patch) => Object.assign(v.checks.find((c) => c.criterionId === id), patch);
    const pace = () => (config.reviewStepDelayMs ? new Promise((r) => setTimeout(r, config.reviewStepDelayMs)) : null);

    // 1) Evidence
    const repo = sub.repoUrl ? await collectRepoEvidence(sub.repoUrl, { githubToken: config.github.token }) : null;
    const ctx = createFetchContext({ baseUrl: sub.url, repo, allowPrivateUrls: config.allowPrivateUrls });
    let page = null;
    try {
      page = await ctx.page(resolveAgainst(sub.url, '/'));
    } catch (err) {
      v.pageError = err.message;
    }
    v.evidence = page
      ? { url: page.url, status: page.status, elapsedMs: page.elapsedMs, title: page.title, headings: page.headings.slice(0, 12), forms: page.forms, hiddenTextFound: !!page.hiddenText }
      : { error: v.pageError };
    if (repo) v.evidence.repo = repo.error ? { error: repo.error } : { url: repo.url, license: repo.license, fileCount: repo.files.length };

    // 2) Prompt-injection scan
    const sources = [];
    if (page) {
      sources.push({ where: 'visible page text', text: page.visibleText }, { where: 'hidden page text', text: page.hiddenText }, { where: 'HTML comments', text: page.comments.join('\n') });
    }
    if (repo?.contents) for (const [f, c] of Object.entries(repo.contents)) sources.push({ where: `repo file ${f}`, text: c });
    sources.push({ where: 'submission note', text: sub.note });
    v.injection = scanForInjection(sources);
    save();

    // 3) Code-measured criteria
    const automated = [];
    for (const c of deal.criteria.filter((c) => KINDS[c.kind].automated)) {
      setCheck(c.id, { state: 'running' });
      save();
      await pace();
      const r = await runAutomatedCheck(c, ctx);
      setCheck(c.id, { state: r.passed ? 'passed' : 'failed', confidence: 1, reasoning: r.reasoning, evidence: r.evidence });
      automated.push({ criterionId: c.id, title: c.title, ...r });
      save();
    }

    // 4) AI-judged criteria, summary and fix notes
    const aiCriteria = deal.criteria.filter((c) => !KINDS[c.kind].automated);
    for (const c of aiCriteria) setCheck(c.id, { state: 'running' });
    save();
    await pace();
    let aiFailed = false;
    try {
      const out = await ai.judge({ deal, aiCriteria, automated, page, repo, injection: v.injection });
      for (const j of out.judgments) setCheck(j.criterionId, { state: j.passed ? 'passed' : 'failed', confidence: j.confidence, reasoning: j.reasoning, evidence: j.evidence });
      v.summary = out.summary;
      v.fixNotes = out.fixNotes;
    } catch (err) {
      aiFailed = true;
      for (const c of aiCriteria) setCheck(c.id, { state: 'failed', confidence: 0, reasoning: `The AI reviewer was unavailable (${err.message}).` });
      v.summary = 'The AI reviewer was unavailable, so this submission needs a human decision.';
      v.fixNotes = [];
    }

    // 5) Decision. Money moves automatically only when every required criterion passed,
    //    nothing tried to manipulate the reviewer, and the AI actually ran.
    const failedRequired = v.checks.filter((c) => c.required && c.state !== 'passed');
    let decision;
    if (v.injection.flagged) {
      decision = 'escalate';
      v.decisionReason = 'The deliverable contains text aimed at the AI reviewer. Verdict never auto-releases money in that case; a human must decide.';
    } else if (aiFailed && aiCriteria.length) {
      decision = 'escalate';
      v.decisionReason = 'The AI reviewer was unavailable for the subjective criteria.';
    } else if (!failedRequired.length) {
      decision = 'release';
      v.decisionReason = `All ${v.checks.filter((c) => c.required).length} required criteria passed.`;
    } else if (deal.submissions.length >= config.maxAttempts) {
      decision = 'escalate';
      v.decisionReason = `${failedRequired.length} required criteria still fail after ${config.maxAttempts} attempts.`;
    } else {
      decision = 'changes_requested';
      v.decisionReason = `${failedRequired.length} required ${failedRequired.length === 1 ? 'criterion fails' : 'criteria fail'}: ${failedRequired.map((c) => c.criterionId).join(', ')}.`;
    }
    v.decision = decision;
    v.status = 'done';
    v.finishedAt = now();
    v.passedCount = v.checks.filter((c) => c.state === 'passed').length;

    const label = { release: 'Release payment', changes_requested: 'Changes requested', escalate: 'Sent to human review' }[decision];
    event(deal, 'verdict', 'verdict', `Attempt ${sub.n}: ${v.passedCount}/${v.checks.length} criteria passed. ${label}. ${v.decisionReason}`);

    if (decision === 'release') {
      deal.status = 'releasing';
      save();
      await settle(deal, 'verdict');
    } else {
      deal.status = decision === 'escalate' ? 'escalated' : 'changes_requested';
      save();
    }
  }

  // ------------------------------------------------------------------ settle / cancel

  async function settle(deal, actor) {
    try {
      if (!deal.paypal.captureId) {
        const cap = await paypal.captureAuthorization(deal.paypal.authorizationId, { dealId: deal.id });
        deal.paypal.captureId = cap.captureId;
        deal.paypal.captureStatus = cap.status;
        deal.paypal.authorizationStatus = 'CAPTURED';
        event(deal, 'paypal', 'captured', `Captured $${deal.amount} from the hold.`, { captureId: cap.captureId, debugId: cap.debugId });
        store.putDeal(deal);
      }
      if (!deal.paypal.payoutBatchId) {
        const amountCents = toCents(deal.amount);
        const feeCents = Math.round((amountCents * deal.platformFeePercent) / 100);
        const payoutAmount = fromCents(amountCents - feeCents);
        deal.paypal.payoutAttempts = (deal.paypal.payoutAttempts || 0) + 1;
        const po = await paypal.createPayout({
          dealId: deal.id,
          attempt: deal.paypal.payoutAttempts,
          receiverEmail: deal.freelancer.paypalEmail,
          amount: payoutAmount,
          note: `Payment for "${deal.title}". Released by Verdict after the work met every agreed criterion.`,
        });
        Object.assign(deal.paypal, { payoutBatchId: po.payoutBatchId, payoutStatus: po.batchStatus, payoutAmount, platformFee: fromCents(feeCents) });
        event(deal, 'paypal', 'payout_sent', `Sent $${payoutAmount} to ${deal.freelancer.paypalEmail} with PayPal Payouts.`, { payoutBatchId: po.payoutBatchId, debugId: po.debugId });
      }
      deal.status = 'released';
      deal.releasedAt = now();
      deal.releasedBy = actor;
      store.putDeal(deal);
    } catch (err) {
      deal.status = 'settlement_failed';
      deal.settlementError = err.message;
      event(deal, 'paypal', 'settlement_failed', `Releasing the payment failed: ${err.message}`, { debugId: err.debugId || null });
      store.putDeal(deal);
    }
    return deal;
  }

  async function voidHold(deal, actor, reason) {
    if (deal.paypal.authorizationId && deal.paypal.authorizationStatus !== 'VOIDED') {
      const r = await paypal.voidAuthorization(deal.paypal.authorizationId, { dealId: deal.id });
      deal.paypal.authorizationStatus = 'VOIDED';
      event(deal, 'paypal', 'voided', `Voided the $${deal.amount} hold. The client was never charged.`, { authorizationId: deal.paypal.authorizationId, debugId: r.debugId });
    }
    deal.status = 'cancelled';
    deal.cancelledAt = now();
    event(deal, actor, 'cancelled', reason);
    return store.putDeal(deal);
  }

  async function cancel(deal, role) {
    require(deal, role, 'client');
    if (!actionsFor(deal, role).includes('cancel')) throw new HttpError(409, 'The deal can only be cancelled before the freelancer submits work. After that, use human review.');
    return withLock(deal, () => voidHold(deal, 'client', `${deal.client.name} cancelled the deal.`));
  }

  async function escalate(deal, role, reason) {
    require(deal, role, 'freelancer', ['changes_requested']);
    deal.status = 'escalated';
    deal.escalation = { by: 'freelancer', reason: String(reason || '').slice(0, 1000), at: now() };
    event(deal, 'freelancer', 'escalated', `${deal.freelancer.name} disputed the verdict: "${deal.escalation.reason || 'No reason given'}"`);
    return store.putDeal(deal);
  }

  async function resolve(deal, role, { decision, note }) {
    require(deal, role, 'client', ['escalated']);
    const n = String(note || '').slice(0, 500);
    return withLock(deal, async () => {
      if (decision === 'release') {
        event(deal, 'client', 'human_release', `${deal.client.name} approved the work after human review.${n ? ` "${n}"` : ''}`);
        deal.status = 'releasing';
        store.putDeal(deal);
        return settle(deal, 'client');
      }
      if (decision === 'cancel') return voidHold(deal, 'client', `${deal.client.name} rejected the work after human review.${n ? ` "${n}"` : ''}`);
      if (decision === 'allow_resubmission') {
        if (deal.submissions.length >= config.maxAttempts) throw new HttpError(409, 'No review attempts left; release or cancel instead.');
        deal.status = 'changes_requested';
        event(deal, 'client', 'reopened', `${deal.client.name} asked for another attempt.${n ? ` "${n}"` : ''}`);
        return store.putDeal(deal);
      }
      throw new HttpError(400, 'Decision must be release, cancel or allow_resubmission.');
    });
  }

  async function retrySettlement(deal, role) {
    require(deal, role, 'client', ['settlement_failed']);
    return withLock(deal, () => settle(deal, 'client'));
  }

  async function refreshPayout(deal) {
    if (deal.status !== 'released' || !deal.paypal.payoutBatchId || deal.paypal.payoutStatus === 'SUCCESS') return deal;
    try {
      const p = await paypal.getPayout(deal.paypal.payoutBatchId);
      if (p.batchStatus && p.batchStatus !== deal.paypal.payoutStatus) {
        deal.paypal.payoutStatus = p.batchStatus;
        if (p.batchStatus === 'SUCCESS') event(deal, 'paypal', 'payout_success', `PayPal confirmed the payout to ${deal.freelancer.paypalEmail}.`, { payoutBatchId: deal.paypal.payoutBatchId });
        store.putDeal(deal);
      }
    } catch {
      /* status refresh is best-effort */
    }
    return deal;
  }

  return {
    STATUS,
    roleFor,
    view,
    createDeal,
    accept,
    createOrder,
    authorize,
    submit,
    escalate,
    resolve,
    cancel,
    retrySettlement,
    refreshPayout,
    idle: () => Promise.all([...reviews]),
  };
}
