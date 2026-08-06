package com.rhecyee.efunny.schedule

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms the drop chain after a reboot or an app update.
 *
 * WorkManager restores its own jobs across reboots, so this is belt and braces
 * rather than the only line of defence -- but a force-stop followed by a reboot
 * leaves nothing pending, and this is what puts it back.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED ->
                DropScheduler.ensureScheduled(context)
        }
    }
}
