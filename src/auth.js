const prisma = require('./db');

async function currentUser(req, res, next) {
  res.locals.user = null;

  if (!req.session.userId) {
    return next();
  }

  const user = await prisma.user.findUnique({
    where: { id: req.session.userId }
  });

  if (!user) {
    req.session.destroy(() => {});
    return next();
  }

  req.user = user;
  res.locals.user = user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.redirect('/login');
  }

  if (req.user.role !== 'ADMIN') {
    return res.status(403).render('error', {
      title: 'Not allowed',
      message: 'This page is only available to admins.'
    });
  }

  next();
}

module.exports = {
  currentUser,
  requireAdmin,
  requireAuth
};
