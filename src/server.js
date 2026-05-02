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
  const date = parseDateInput(req.query.date || todayString());
  const questions = await prisma.question.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' }
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

  res.render('dashboard', {
    title: 'Daily habits',
    date,
    displayDate: formatLongDate(date),
    previousDate: shiftDate(date, -1),
    nextDate: shiftDate(date, 1),
    today: todayString(),
    questions,
    responseByQuestion
  });
});

app.post('/responses', requireAuth, async (req, res) => {
  const date = parseDateInput(req.body.date || todayString());
  const questions = await prisma.question.findMany({ where: { active: true } });

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

app.get('/admin', requireAdmin, async (req, res) => {
  const questions = await prisma.question.findMany({
    orderBy: { createdAt: 'asc' }
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

  await prisma.question.create({ data });
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
