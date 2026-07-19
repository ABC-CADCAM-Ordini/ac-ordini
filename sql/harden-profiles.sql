-- ══════════════════════════════════════════════════════════════
-- BLINDATURA profiles — impedire l'auto-promozione di ruolo
-- ══════════════════════════════════════════════════════════════
-- Contesto (verificato 2026-07-19 su produzione): le policy RLS di `profiles` sono
-- corrette — SELECT a tutti gli autenticati, ALL solo a is_admin(), UPDATE solo sulla
-- PROPRIA riga (profiles_update_own: id = auth.uid()).
--
-- Residuo: profiles_update_own è a livello di RIGA, non di COLONNA → un operatore, con
-- una chiamata API grezza sulla propria riga, potrebbe cambiarsi `ruolo` a 'admin'
-- (o riattivarsi `attivo`). Questo trigger chiude il buco: `ruolo` e `attivo` li può
-- cambiare SOLO un admin, o la Edge Function (service-role). Nome/telefono/email restano
-- liberamente modificabili dall'interessato.
--
-- Non tocca RLS, login (SELECT) né la modifica dei contatti. Reversibile:
--   drop trigger if exists trg_guard_profiles_privilege on public.profiles;

create or replace function public.guard_profiles_privilege()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.ruolo is distinct from old.ruolo) or (new.attivo is distinct from old.attivo) then
    -- Consentito solo ad admin (via UI) o al service-role (Edge Function gestione-operatori).
    if not (
      public.is_admin()
      or current_user in ('service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin')
      or coalesce(auth.role(), '') = 'service_role'
    ) then
      raise exception 'Solo un amministratore può cambiare ruolo o stato attivo di un operatore';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profiles_privilege on public.profiles;
create trigger trg_guard_profiles_privilege
before update on public.profiles
for each row execute function public.guard_profiles_privilege();
