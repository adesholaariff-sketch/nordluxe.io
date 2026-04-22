const express = require('express');
const path = require('path');
const app = express();

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

// Start server
const PORT = 8000;
app.listen(PORT, () => {
  console.log(`Static file server running at http://localhost:${PORT}`);
});