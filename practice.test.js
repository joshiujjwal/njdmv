const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const appUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;

test('should link to the official manual when hosted and the adjacent PDF when opened locally', async ({ page }) => {
  const hostedUrl = 'https://nj-practice.example/njdmv/';
  await page.route(hostedUrl, route => route.fulfill({
    path: path.join(__dirname, 'index.html'),
    contentType: 'text/html'
  }));
  for (const url of [hostedUrl, appUrl]) {
    const manual = url === hostedUrl ? 'https://www.nj.gov/mvc/pdf/license/drivermanual.pdf' : 'drivermanual.pdf';
    await page.goto(url);
    await expect(page.getByRole('link', { name: 'Open manual', exact: true })).toHaveAttribute('href', manual);
    await page.getByRole('button', { name: 'Start studying', exact: true }).click();
    await page.locator('.answer').first().click();
    await expect(page.locator('#feedback .source')).toHaveAttribute('href', new RegExp(`^${manual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#page=\\d+$`));
  }
});

async function answerCurrent(page, correct) {
  const index = await page.evaluate(wantsCorrect => {
    const session = window.NJPractice.session;
    const q = session.questions[session.index];
    return q.choices.findIndex(choice => (choice === q.options[0]) === wantsCorrect);
  }, correct);
  await page.locator('.answer').nth(index).click();
}

async function completeExam(page, correctCount) {
  await page.getByRole('button', { name: 'Start mock exam', exact: true }).click();
  for (const index of Array.from({ length: 50 }, (_, i) => i)) {
    await answerCurrent(page, index < correctCount);
    if (index < 49) await page.getByRole('button', { name: 'Next question', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Finish test', exact: true }).click();
}

test('should start a 50-question exam with unique questions and no answer spoilers', async ({ page }) => {
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Start mock exam', exact: true }).click();
  await expect(page.getByText('Question 1 of 50', { exact: true })).toBeVisible();
  await expect(page.locator('.answer')).toHaveCount(4);
  await page.locator('.answer').first().click();
  await expect(page.locator('#feedback')).toBeHidden();
  const ids = await page.evaluate(() => window.NJPractice.session.questions.map(q => q.id));
  expect(new Set(ids).size).toBe(50);
  await page.getByRole('button', { name: 'Next question', exact: true }).click();
  await expect(page.getByText('Question 2 of 50', { exact: true })).toBeVisible();
});

test('should provide at least 250 distinct source-linked questions covering automobile topics and signs', async ({ page }) => {
  await page.goto(appUrl);
  const bank = await page.evaluate(() => window.NJPractice.bank);
  expect(bank.length).toBeGreaterThanOrEqual(250);
  expect(new Set(bank.map(q => q.id)).size).toBe(bank.length);
  expect(new Set(bank.map(q => q.prompt)).size).toBe(bank.length);
  expect(new Set(bank.map(q => q.topic)).size).toBeGreaterThanOrEqual(12);
  expect(bank.filter(q => q.sign).length).toBeGreaterThanOrEqual(15);
  for (const q of bank) {
    expect(new Set(q.options).size).toBe(4);
    expect(q.options.every(option => typeof option === 'string' && option.length > 0)).toBe(true);
    expect(q.explanation.length).toBeGreaterThan(25);
    expect(Number.isInteger(q.page) && q.page >= 3 && q.page <= 243).toBe(true);
    expect(q.prompt.length).toBeGreaterThan(15);
  }
});

test('should pass at exactly 40 of 50 and fail at 39 with complete answer explanations', async ({ page }) => {
  await page.goto(appUrl);
  await completeExam(page, 40);
  await expect(page.locator('#result-title')).toHaveText('Practice exam passed');
  await expect(page.locator('#result-score')).toHaveText('40 / 50');
  await expect(page.locator('.review-item')).toHaveCount(50);
  await expect(page.locator('.review-item a')).toHaveCount(50);
  await page.getByRole('button', { name: 'Return to dashboard', exact: true }).click();
  await completeExam(page, 39);
  await expect(page.locator('#result-title')).toHaveText('Keep practicing');
  await expect(page.locator('#result-score')).toHaveText('39 / 50');
});

test('should give immediate source-linked feedback in a signs-only study drill and lock the answer', async ({ page }) => {
  await page.goto(appUrl);
  await page.getByLabel('Topic', { exact: true }).selectOption('Signs & markings');
  await page.getByLabel('Questions per session').selectOption('all');
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  const questions = await page.evaluate(() => window.NJPractice.session.questions);
  expect(questions.every(q => q.topic === 'Signs & markings')).toBe(true);
  expect(new Set(questions.map(q => q.id)).size).toBe(questions.length);
  await answerCurrent(page, false);
  await expect(page.locator('#feedback')).toContainText('Not quite');
  await expect(page.locator('#feedback a')).toHaveAttribute('href', /drivermanual\.pdf#page=\d+/);
  await expect(page.locator('.answer:disabled')).toHaveCount(4);
  await page.getByRole('button', { name: 'Next question', exact: true }).click();
  await expect(page.locator('#feedback')).toBeHidden();
  const signIndex = questions.findIndex(q => q.sign);
  await page.getByText('Jump to a question', { exact: true }).click();
  await page.getByRole('button', { name: `Question ${signIndex + 1}, ${signIndex === 0 ? 'answered' : 'unanswered'}`, exact: true }).click();
  await expect(page.locator('#sign svg')).toBeVisible();
  await expect(page.locator('#sign svg')).toHaveAttribute('role', 'img');
});

test('should resume the exact saved study session and review missed or skipped questions until corrected', async ({ page }) => {
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  await answerCurrent(page, false);
  const saved = await page.evaluate(() => JSON.stringify(window.NJPractice.session));
  await page.reload();
  await page.getByRole('button', { name: 'Resume session', exact: true }).click();
  expect(await page.evaluate(() => JSON.stringify(window.NJPractice.session))).toBe(saved);
  await expect(page.locator('#feedback')).toContainText('Not quite');
  await page.getByRole('button', { name: 'Next question', exact: true }).click();
  await answerCurrent(page, true);
  await page.getByRole('button', { name: 'Finish test', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Finish and score', exact: true }).click();
  await page.getByRole('button', { name: 'Return to dashboard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review missed (9)', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review missed (9)', exact: true }).click();
  await expect(page.getByText('Question 1 of 9', { exact: true })).toBeVisible();
  await answerCurrent(page, true);
  await page.getByRole('button', { name: 'Back to dashboard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review missed (8)', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Review missed (8)', exact: true })).toBeEnabled();
});

test('should browse the entire question bank, filter by topic and search, and handle no matches safely', async ({ page }) => {
  await page.goto(appUrl);
  const total = await page.evaluate(() => window.NJPractice.bank.length);
  await page.getByRole('button', { name: 'Browse all questions', exact: true }).click();
  await expect(page.locator('.library-question')).toHaveCount(total);
  await page.getByLabel('Filter topic').selectOption('Stops, lights & parking');
  await page.getByLabel('Search questions and explanations').fill('hydrant');
  await expect(page.locator('.library-question')).toHaveCount(1);
  await page.getByText('Show answer & explanation', { exact: true }).click();
  await expect(page.locator('.library-question')).toContainText('Within 10 feet');
  await expect(page.locator('.library-question a')).toHaveAttribute('href', 'drivermanual.pdf#page=87');
  await page.getByLabel('Search questions and explanations').fill('<img src=x onerror=alert(1)>');
  await expect(page.locator('#library-count')).toContainText('No matching questions');
  await expect(page.locator('.library-question')).toHaveCount(0);
  await expect(page.locator('#library img')).toHaveCount(0);
});

test('should include every study topic in a mock exam even with a fixed random sequence', async ({ page }) => {
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Start mock exam', exact: true }).click();
  const { bankTopics, examTopics } = await page.evaluate(() => ({
    bankTopics: [...new Set(window.NJPractice.bank.map(q => q.topic))].sort(),
    examTopics: [...new Set(window.NJPractice.session.questions.map(q => q.topic))].sort()
  }));
  expect(examTopics).toEqual(bankTopics);
});

test('should preserve an unfinished exam when replacing or finishing is cancelled', async ({ page }) => {
  await page.goto(appUrl);
  await expect(page.getByRole('button', { name: 'Review missed (0)', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Start mock exam', exact: true }).click();
  await answerCurrent(page, false);
  await answerCurrent(page, true);
  const saved = await page.evaluate(() => JSON.stringify(window.NJPractice.session));
  await page.getByRole('button', { name: 'Finish test', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#quiz')).toBeVisible();
  await page.getByRole('button', { name: 'Back to dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Resume session', exact: true }).click();
  expect(await page.evaluate(() => JSON.stringify(window.NJPractice.session))).toBe(saved);
  await expect(page.locator('#feedback')).toBeHidden();
  await page.getByRole('button', { name: 'Finish test', exact: true }).click();
  await page.getByRole('button', { name: 'Finish and score', exact: true }).click();
  await expect(page.locator('#result-score')).toHaveText('1 / 50');
  await expect(page.locator('.review-item .bad')).toHaveCount(49);
});

test('should report corrupt saved data without overwriting it and require confirmation to reset', async ({ page }) => {
  await page.goto(appUrl);
  await page.evaluate(() => localStorage.setItem('nj-road-ready-v1', '{invalid'));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Saved progress could not be loaded');
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  await answerCurrent(page, true);
  expect(await page.evaluate(() => localStorage.getItem('nj-road-ready-v1'))).toBe('{invalid');
  await page.getByRole('button', { name: 'Back to dashboard', exact: true }).click();
  await page.getByRole('button', { name: 'Reset saved progress', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('nj-road-ready-v1'))).toBe('{invalid');
  await page.getByRole('button', { name: 'Reset saved progress', exact: true }).click();
  await page.getByRole('button', { name: 'Reset progress', exact: true }).click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('alert')).toBeHidden();
  expect(await page.evaluate(() => Object.keys(window.NJPractice.progress.records))).toEqual([]);
});

test('should reject structurally invalid saved sessions instead of resuming broken questions', async ({ page }) => {
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Start mock exam', exact: true }).click();
  await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('nj-road-ready-v1'));
    data.active.questions[0].choices = ['fake', 'fake', 'fake', 'fake'];
    localStorage.setItem('nj-road-ready-v1', JSON.stringify(data));
  });
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Invalid saved question');
  await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Start mock exam', exact: true }).click();
  await expect(page.locator('.answer')).toHaveCount(4);
});

test('should keep practice usable and show an explicit warning when browser storage is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Storage disabled for test', 'QuotaExceededError'); };
  });
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Progress could not be saved');
  await answerCurrent(page, true);
  await expect(page.locator('#feedback')).toContainText('Correct.');
  await page.getByRole('button', { name: 'Next question', exact: true }).click();
  await expect(page.getByText('Question 2 of 10', { exact: true })).toBeVisible();
});

test('should let a learner practice every bank question once with working answers, illustrations and citations', async ({ page }) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(appUrl);
  await page.getByLabel('Questions per session').selectOption('all');
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  const questions = await page.evaluate(() => window.NJPractice.session.questions);
  expect(new Set(questions.map(q => q.id)).size).toBe(await page.evaluate(() => window.NJPractice.bank.length));
  for (const [index, q] of questions.entries()) {
    await answerCurrent(page, true);
    await expect(page.locator('#feedback')).toContainText(q.explanation);
    await expect(page.locator('#feedback a')).toHaveAttribute('href', `drivermanual.pdf#page=${q.page}`);
    await expect(page.locator('#sign svg')).toHaveCount(q.sign ? 1 : 0);
    if (index < questions.length - 1) await page.getByRole('button', { name: 'Next question', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Finish test', exact: true }).click();
  await expect(page.locator('#result-score')).toHaveText(`${questions.length} / ${questions.length}`);
  await expect(page.locator('#result-title')).toHaveText('Study session complete');
  await page.getByRole('button', { name: 'Return to dashboard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review missed (0)', exact: true })).toBeDisabled();
  const records = await page.evaluate(() => Object.values(window.NJPractice.progress.records));
  expect(records.every(record => record.attempts === 1 && record.correct === 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('should run offline at mobile width and support keyboard answering without horizontal overflow', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.setOffline(true);
  const network = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url())) network.push(request.url());
  });
  await page.goto(appUrl);
  await page.getByRole('button', { name: 'Start studying', exact: true }).click();
  await page.locator('.answer').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#feedback')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next question', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(network).toEqual([]);
});

test('should cap a topic drill at available questions instead of repeating questions to reach ten', async ({ page }) => {
  await page.goto(appUrl);
  await page.getByRole('button', { name: /Testing & documents.*Practice 8 questions/ }).click();
  await expect(page.getByText('Question 1 of 8', { exact: true })).toBeVisible();
  const questions = await page.evaluate(() => window.NJPractice.session.questions);
  expect(questions.every(q => q.topic === 'Testing & documents')).toBe(true);
  expect(new Set(questions.map(q => q.id)).size).toBe(8);
});
