import { withSupabase } from 'npm:@supabase/server@^1'
import webpush from 'npm:web-push@3.6.7'

const WINDOW_MINUTES = 5

function inWindow(target: Date, minutesFromNow: number) {
  const now = Date.now()
  const targetMs = now + minutesFromNow * 60_000
  const windowMs = WINDOW_MINUTES * 60_000
  return target.getTime() >= targetMs - windowMs && target.getTime() < targetMs + windowMs
}

function reminderType(endAt: string) {
  const d = new Date(endAt)
  if (inWindow(d, 24 * 60)) return '1day'
  if (inWindow(d, 60)) return '1hour'
  return null
}

export default {
  fetch: withSupabase({ auth: 'secret' }, async (_req, ctx) => {
    try {
      const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')
      const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')
      if (!vapidPublicKey || !vapidPrivateKey) throw new Error('VAPID keys are not configured.')

      const webPush = webpush
      webPush.setVapidDetails(
        Deno.env.get('VAPID_SUBJECT') || 'mailto:your-email@example.com',
        vapidPublicKey,
        vapidPrivateKey,
      )

      const nowIso = new Date().toISOString()
      const upper = new Date(Date.now() + 24 * 60 * 60_000 + WINDOW_MINUTES * 60_000).toISOString()
      const { data: applications, error: appError } = await ctx.supabaseAdmin
        .from('applications')
        .select('id,name,end_at,status,event:events!inner(id,name,user_id),performance_statuses:application_performances(status)')
        .not('end_at', 'is', null)
        .gt('end_at', nowIso)
        .lt('end_at', upper)
      if (appError) throw appError

      let sent = 0
      let skipped = 0

      for (const app of applications || []) {
        const type = reminderType(app.end_at)
        if (!type) continue
        const userId = app.event?.user_id
        if (!userId) continue

        const { data: settings, error: settingsError } = await ctx.supabaseAdmin
          .from('user_settings')
          .select('notify_deadline_1day,notify_deadline_1hour')
          .eq('user_id', userId)
          .maybeSingle()
        if (settingsError) throw settingsError

        const enabled = type === '1day'
          ? settings?.notify_deadline_1day !== false
          : settings?.notify_deadline_1hour !== false
        if (!enabled) { skipped++; continue }

        // 対応済みの申込には通知しない。
        const performanceStatuses = app.performance_statuses || []
        const allPerformanceHandled = performanceStatuses.length > 0 && performanceStatuses.every((x: { status?: string }) => ['応募済み', '当選', '落選'].includes(x.status || ''))
        if (['応募済み', '当選', '落選'].includes(app.status || '') || allPerformanceHandled) {
          skipped++
          continue
        }

        const { data: existing } = await ctx.supabaseAdmin
          .from('deadline_notification_logs')
          .select('id')
          .eq('user_id', userId)
          .eq('application_id', app.id)
          .eq('reminder_type', type)
          .maybeSingle()
        if (existing) { skipped++; continue }

        const { data: subscriptions, error: subError } = await ctx.supabaseAdmin
          .from('push_subscriptions')
          .select('id,endpoint,p256dh,auth')
          .eq('user_id', userId)
        if (subError) throw subError

        const remainingText = type === '1day' ? 'あと1日' : 'あと1時間'
        const title = '申込締切のお知らせ'
        const body = `「${app.event?.name || 'イベント'}」の${app.name || '申込'}は${remainingText}です。`
        const payload = JSON.stringify({
          title,
          body,
          url: './',
          tag: `deadline-${app.id}-${type}`,
        })

        let delivered = false
        for (const sub of subscriptions || []) {
          try {
            await webPush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload,
            )
            delivered = true
          } catch (error) {
            const statusCode = error?.statusCode
            if (statusCode === 404 || statusCode === 410) {
              await ctx.supabaseAdmin.from('push_subscriptions').delete().eq('id', sub.id)
            } else {
              console.error('push failed', error)
            }
          }
        }

        await ctx.supabaseAdmin.from('deadline_notification_logs').insert({
          user_id: userId,
          application_id: app.id,
          reminder_type: type,
          sent_at: new Date().toISOString(),
          delivered,
        })

        await ctx.supabaseAdmin.from('notifications').insert({
          user_id: userId,
          type: 'deadline',
          title,
          body,
          link_type: 'event',
          link_id: app.event?.id || null,
          is_read: false,
        })

        if (delivered) sent++
      }

      return Response.json({ ok: true, sent, skipped, checked: applications?.length || 0 })
    } catch (error) {
      console.error(error)
      return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 })
    }
  }),
}
