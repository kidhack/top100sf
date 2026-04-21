-- Align default list title with app DEFAULT_LIST_NAME (fallbacks, menus).
update public.lists
set name = 'SF Chronicle Top 100 - 2026',
    updated_at = now()
where slug = 'chronicle-top-100-2026';
