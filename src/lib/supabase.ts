import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) throw new Error('Supabase connection details are missing');

export const supabase = createClient(url, anonKey);

export const SCREENSHOT_BUCKET = 'evidence-screenshots';
