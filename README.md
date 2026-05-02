# Habit Tracker

A small health habit tracking app with user registration, admin-managed daily questions, and PostgreSQL-backed daily responses.

## Features

- Users can register and log in with a name and password.
- The first registered user is automatically made an admin.
- Admins can create, edit, enable, and disable questions.
- Admins can reorder questions and manage user roles.
- Questions can be yes/no, multiple choice, text, or number.
- Users can fill answers for today or navigate to previous/future dates.
- Users can view numeric trend charts and a weekly completion summary.
- Responses are stored in PostgreSQL with one answer per user, question, and date.

## Local Setup

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`.

## Render Setup

Create a Render Postgres database, then set these environment variables on the Render web service:

```text
DATABASE_URL=<Render internal database URL>
SESSION_SECRET=<long random string>
NODE_ENV=production
```

Use these commands for the Render web service:

```text
Build Command: npm install && npx prisma generate && npx prisma migrate deploy
Start Command: npm start
```

After the first deployment, register the first account. That account becomes the admin and can add questions.
