require('dotenv/config');

const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const prisma = require('./db');
const { currentUser, requireAdmin, requireAuth } = require('./auth');
const {
  dateForDb,
  formatLongDate,
  parseDateInput,
  shiftDate,
  todayString
} = require('./date-utils');

const app = express();
const port = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET || 'dev-only-change-me';

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production.');
}

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    store: new pgSession({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  })
);

app.use(currentUser);

app.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.error = null;
  res.locals.success = null;
  next();
});

app.get('/', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

app.get('/register', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  res.render('register', { title: 'Register' });
});

app.post('/register', async (req, res) => {
  const name = (req.body.name || '').trim();
  const password = req.body.password || '';

  if (!name || password.length < 8) {
    return res.status(400).render('register', {
      title: 'Register',
      error: 'Use a name and a password with at least 8 characters.'
    });
  }

  const existing = await prisma.user.findUnique({ where: { name } });
  if (existing) {
    return res.status(400).render('register', {
      title: 'Register',
      error: 'That name is already registered.'
    });
  }

  const userCount = await prisma.user.count();
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      name,
      passwordHash,
      role: userCount === 0 ? 'ADMIN' : 'USER'
    }
  });

  req.session.userId = user.id;
  res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { title: 'Log in' });
});

app.post('/login', async (req, res) => {
  const name = (req.body.name || '').trim();
  const password = req.body.password || '';
  const user = await prisma.user.findUnique({ where: { name } });
  const passwordOk = user && (await bcrypt.compare(password, user.passwordHash));

  if (!passwordOk) {
    return res.status(401).render('login', {
      title: 'Log in',
      error: 'Name or password is incorrect.'
    });
  }

  req.session.userId = user.id;
  res.redirect('/dashboard');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const browserToday = getBrowserToday(req);
  const date = parseDateInput(req.query.date || browserToday, browserToday);
  const questions = await prisma.question.findMany({
    where: { active: true },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }]
  });
  const responses = await prisma.response.findMany({
    where: {
      userId: req.user.id,
      answerDate: dateForDb(date)
    }
  });
  const responseByQuestion = new Map(
    responses.map((response) => [response.questionId, response])
  );
  const summary = await getDashboardSummary(req.user.id, questions.length, browserToday);

  res.render('dashboard', {
    title: 'Daily habits',
    date,
    displayDate: formatLongDate(date),
    previousDate: shiftDate(date, -1),
    nextDate: shiftDate(date, 1),
    today: browserToday,
    questions,
    responseByQuestion,
    summary
  });
});

app.post('/responses', requireAuth, async (req, res) => {
  const browserToday = getBrowserToday(req);
  const date = parseDateInput(req.body.date || browserToday, browserToday);
  const questions = await prisma.question.findMany({
    where: { active: true },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }]
  });

  await Promise.all(
    questions.map(async (question) => {
      const rawValue = req.body[`question_${question.id}`];
      const data = valueForQuestion(question, rawValue);

      if (!data) {
        await prisma.response.deleteMany({
          where: {
            userId: req.user.id,
            questionId: question.id,
            answerDate: dateForDb(date)
          }
        });
        return;
      }

      await prisma.response.upsert({
        where: {
          userId_questionId_answerDate: {
            userId: req.user.id,
            questionId: question.id,
            answerDate: dateForDb(date)
          }
        },
        create: {
          userId: req.user.id,
          questionId: question.id,
          answerDate: dateForDb(date),
          ...data
        },
        update: data
      });
    })
  );

  res.redirect(`/dashboard?date=${date}`);
});

app.get('/history', requireAuth, async (req, res) => {
  const browserToday = getBrowserToday(req);
  const weekOffset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0);
  const windowEnd = shiftDate(browserToday, weekOffset * -7);
  const windowStart = shiftDate(windowEnd, -34);
  const trendWindow = {
    start: windowStart,
    end: windowEnd,
    label: `${formatShortDate(windowStart)} - ${formatShortDate(windowEnd)}`,
    offset: weekOffset,
    olderOffset: weekOffset + 1,
    newerOffset: Math.max(0, weekOffset - 1),
    canGoNewer: weekOffset > 0
  };
  const trendQuestions = await prisma.question.findMany({
    where: { type: { in: ['NUMBER', 'YES_NO'] }, active: true },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }]
  });
  const numericQuestions = trendQuestions.filter((question) => question.type === 'NUMBER');
  const yesNoQuestions = trendQuestions.filter((question) => question.type === 'YES_NO');
  const questionIds = trendQuestions.map((question) => question.id);
  const responses =
    questionIds.length === 0
      ? []
      : await prisma.response.findMany({
          where: {
            userId: req.user.id,
            questionId: { in: questionIds },
            answerDate: {
              gte: dateForDb(windowStart),
              lte: dateForDb(windowEnd)
            }
          },
          orderBy: { answerDate: 'asc' }
        });
  const responsesByQuestion = groupByQuestionId(responses);
  const charts = numericQuestions.map((question) =>
    buildNumberChart(
      question,
      (responsesByQuestion.get(question.id) || []).filter(
        (response) => response.valueNumber !== null
      ),
      trendWindow
    )
  );
  const habitCalendars = yesNoQuestions.map((question) =>
    buildYesNoCalendar(question, responsesByQuestion.get(question.id) || [], trendWindow)
  );

  res.render('history', {
    title: 'Trends',
    charts,
    habitCalendars,
    trendWindow
  });
});

app.get('/admin', requireAdmin, async (req, res) => {
  const questions = await prisma.question.findMany({
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }]
  });

  res.render('admin/index', {
    title: 'Admin',
    questions
  });
});

app.get('/admin/questions/new', requireAdmin, (req, res) => {
  res.render('admin/question-form', {
    title: 'New question',
    question: null
  });
});

app.post('/admin/questions', requireAdmin, async (req, res) => {
  const data = questionDataFromBody(req.body);
  if (!data.label) {
    return res.status(400).render('admin/question-form', {
      title: 'New question',
      question: data,
      error: 'Question text is required.'
    });
  }

  const lastQuestion = await prisma.question.findFirst({
    orderBy: [{ orderIndex: 'desc' }, { createdAt: 'desc' }]
  });
  await prisma.question.create({
    data: {
      ...data,
      orderIndex: (lastQuestion?.orderIndex || 0) + 10
    }
  });
  res.redirect('/admin');
});

app.get('/admin/questions/:id/edit', requireAdmin, async (req, res) => {
  const question = await prisma.question.findUnique({
    where: { id: req.params.id }
  });

  if (!question) {
    return res.status(404).render('error', {
      title: 'Question not found',
      message: 'That question does not exist.'
    });
  }

  res.render('admin/question-form', {
    title: 'Edit question',
    question
  });
});

app.post('/admin/questions/:id', requireAdmin, async (req, res) => {
  const data = questionDataFromBody(req.body);
  await prisma.question.update({
    where: { id: req.params.id },
    data
  });
  res.redirect('/admin');
});

app.post('/admin/questions/:id/toggle', requireAdmin, async (req, res) => {
  const question = await prisma.question.findUnique({
    where: { id: req.params.id }
  });

  if (question) {
    await prisma.question.update({
      where: { id: question.id },
      data: { active: !question.active }
    });
  }

  res.redirect('/admin');
});

app.post('/admin/questions/:id/move', requireAdmin, async (req, res) => {
  const direction = req.body.direction === 'down' ? 'down' : 'up';
  const questions = await prisma.question.findMany({
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }]
  });
  const index = questions.findIndex((question) => question.id === req.params.id);
  const swapIndex = direction === 'up' ? index - 1 : index + 1;

  if (index >= 0 && swapIndex >= 0 && swapIndex < questions.length) {
    const current = questions[index];
    const other = questions[swapIndex];
    await prisma.$transaction([
      prisma.question.update({
        where: { id: current.id },
        data: { orderIndex: other.orderIndex }
      }),
      prisma.question.update({
        where: { id: other.id },
        data: { orderIndex: current.orderIndex }
      })
    ]);
  }

  res.redirect('/admin');
});

app.get('/admin/users', requireAdmin, async (req, res) => {
  const users = await prisma.user.findMany({
    include: {
      _count: {
        select: { responses: true }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  res.render('admin/users', {
    title: 'Users',
    users
  });
});

app.post('/admin/users/:id/role', requireAdmin, async (req, res) => {
  const nextRole = req.body.role === 'ADMIN' ? 'ADMIN' : 'USER';
  const targetUser = await prisma.user.findUnique({
    where: { id: req.params.id }
  });

  if (!targetUser) {
    return res.redirect('/admin/users');
  }

  if (targetUser.role === 'ADMIN' && nextRole === 'USER') {
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    if (adminCount <= 1) {
      return res.status(400).render('error', {
        title: 'Cannot update role',
        message: 'At least one admin account must remain.'
      });
    }
  }

  await prisma.user.update({
    where: { id: targetUser.id },
    data: { role: nextRole }
  });

  res.redirect('/admin/users');
});

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Not found',
    message: 'That page does not exist.'
  });
});

function questionDataFromBody(body) {
  const type = body.type || 'YES_NO';
  const options =
    type === 'MULTIPLE_CHOICE'
      ? (body.options || '')
          .split('\n')
          .map((option) => option.trim())
          .filter(Boolean)
      : [];

  return {
    label: (body.label || '').trim(),
    type,
    unit: (body.unit || '').trim() || null,
    options
  };
}

async function getDashboardSummary(userId, activeQuestionCount, today) {
  const lastSevenDays = Array.from({ length: 7 }, (_, index) =>
    shiftDate(today, index - 6)
  );
  const since = dateForDb(lastSevenDays[0]);
  const recentResponses = await prisma.response.findMany({
    where: {
      userId,
      answerDate: { gte: since }
    },
    select: {
      answerDate: true,
      questionId: true
    }
  });
  const responseCounts = countResponsesByDate(recentResponses);
  const lastSeven = lastSevenDays.map((date) => ({
    date,
    shortLabel: formatShortDate(date),
    count: responseCounts.get(date) || 0,
    complete:
      activeQuestionCount > 0 && (responseCounts.get(date) || 0) >= activeQuestionCount
  }));

  return {
    activeQuestionCount,
    answeredToday: responseCounts.get(today) || 0,
    lastSeven,
    missingDays: lastSeven.filter((day) => !day.complete).length,
    streak: await getCurrentStreak(userId, today)
  };
}

async function getCurrentStreak(userId, today) {
  const since = dateForDb(shiftDate(today, -364));
  const responses = await prisma.response.findMany({
    where: {
      userId,
      answerDate: { gte: since }
    },
    select: { answerDate: true },
    distinct: ['answerDate']
  });
  const loggedDates = new Set(
    responses.map((response) => response.answerDate.toISOString().slice(0, 10))
  );
  let streak = 0;
  let cursor = today;

  for (let index = 0; index < 365; index += 1) {
    if (!loggedDates.has(cursor)) {
      break;
    }

    streak += 1;
    cursor = shiftDate(cursor, -1);
  }

  return streak;
}

function countResponsesByDate(responses) {
  const counts = new Map();
  responses.forEach((response) => {
    const date = response.answerDate.toISOString().slice(0, 10);
    counts.set(date, (counts.get(date) || 0) + 1);
  });
  return counts;
}

function groupByQuestionId(responses) {
  const groups = new Map();
  responses.forEach((response) => {
    const existing = groups.get(response.questionId) || [];
    existing.push(response);
    groups.set(response.questionId, existing);
  });
  return groups;
}

function buildNumberChart(question, responses, trendWindow) {
  const points = responses.map((response) => ({
    date: response.answerDate.toISOString().slice(0, 10),
    label: formatShortDate(response.answerDate.toISOString().slice(0, 10)),
    value: response.valueNumber
  }));
  const values = points.map((point) => point.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const paddedMin = min === max ? min - 1 : min;
  const paddedMax = min === max ? max + 1 : max;
  const width = 680;
  const height = 220;
  const left = 44;
  const right = 18;
  const top = 18;
  const bottom = 38;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const svgPoints = points.map((point, index) => {
    const x =
      left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const y =
      top + plotHeight - ((point.value - paddedMin) / (paddedMax - paddedMin)) * plotHeight;
    return { ...point, x, y };
  });
  const pathData = svgPoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');

  return {
    question,
    points: svgPoints,
    pathData,
    min: paddedMin,
    max: paddedMax,
    latest: points[points.length - 1] || null,
    width,
    height
  };
}

function buildYesNoCalendar(question, responses, trendWindow) {
  const responseByDate = new Map(
    responses.map((response) => [
      response.answerDate.toISOString().slice(0, 10),
      response.valueBoolean
    ])
  );
  const days = Array.from({ length: 35 }, (_, index) => {
    const date = shiftDate(trendWindow.start, index);
    const value = responseByDate.get(date);
    return {
      date,
      label: formatShortDate(date),
      value,
      state: value === true ? 'yes' : value === false ? 'no' : 'empty'
    };
  });
  const yesCount = days.filter((day) => day.value === true).length;
  const noCount = days.filter((day) => day.value === false).length;
  const answeredCount = yesCount + noCount;
  const yesRate = answeredCount ? Math.round((yesCount / answeredCount) * 100) : 0;
  const weeks = [];

  for (let index = 0; index < days.length; index += 7) {
    const weekDays = days.slice(index, index + 7);
    weeks.push({
      label: `${weekDays[0].label} - ${weekDays[weekDays.length - 1].label}`,
      days: weekDays
    });
  }

  return {
    question,
    days,
    weeks,
    yesCount,
    noCount,
    answeredCount,
    yesRate
  };
}

function getBrowserToday(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return parseDateInput(cookies.ht_today || todayString());
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(';').reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) {
      return cookies;
    }

    cookies[rawName] = decodeURIComponent(rawValue.join('=') || '');
    return cookies;
  }, {});
}

function formatShortDate(value) {
  return dateForDb(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

function valueForQuestion(question, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return null;
  }

  if (question.type === 'YES_NO') {
    return { valueBoolean: rawValue === 'yes', valueNumber: null, valueText: null };
  }

  if (question.type === 'NUMBER') {
    const valueNumber = Number(rawValue);
    if (!Number.isFinite(valueNumber)) {
      return null;
    }
    return { valueNumber, valueBoolean: null, valueText: null };
  }

  return {
    valueText: String(rawValue).trim(),
    valueNumber: null,
    valueBoolean: null
  };
}

app.listen(port, () => {
  console.log(`Habit tracker listening on port ${port}`);
});
