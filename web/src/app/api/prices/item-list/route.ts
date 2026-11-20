import { requireFlag } from '@/lib/auth';
import { readPublishedItemList } from '@/lib/prices';

export const dynamic = 'force-dynamic';

export const GET = requireFlag('price_books', readPublishedItemList);
