const { AVAILABLE_ROUTES } = require("../config/app");

const notFound = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    availableRoutes: AVAILABLE_ROUTES,
  });
};

module.exports = notFound;
