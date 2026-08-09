// db/index.js
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, // Set to true if using SSL
});

export const connectDB = async () => {
  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected successfully');
  } catch (error) {
    console.error('Error connecting to PostgreSQL:', error);
    throw error;
  }
};

export const closeDB = async () => {
  await pool.end();
};

export default pool;
