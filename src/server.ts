import dotenv from 'dotenv';
import express, { Request, Response } from 'express';

// Load variables from .env into process.env before anything reads them.
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware to parse JSON
app.use(express.json());

// Basic route
// app.get('/', (req: Request, res: Response) => {
//   res.status(200).send('Hello, TypeScript!');
// });

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
