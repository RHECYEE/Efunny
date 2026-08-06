package com.rhecyee.efunny.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.rhecyee.efunny.core.feelers.Credentials
import com.rhecyee.efunny.core.feelers.SearchBudget
import java.time.Clock
import java.time.LocalDate
import java.time.ZoneId

/**
 * API keys and the metered-call ledger.
 *
 * Nothing is baked into the APK. The user pastes their own keys, which is why
 * the app is useful before any setup -- RSS sources need no credentials at all --
 * and why each install spends its own quota instead of everyone sharing one
 * rate limit that a single heavy user could exhaust for everybody.
 */
class SecureSettings(context: Context, private val clock: Clock = Clock.systemUTC()) : Credentials, SearchBudget {

    private val ledgerLock = Any()

    private val prefs: SharedPreferences = try {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "efunny_secure",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (_: Exception) {
        // A device with a broken keystore should still run the RSS sources
        // rather than refusing to launch. Keys simply will not persist.
        context.getSharedPreferences("efunny_fallback", Context.MODE_PRIVATE)
    }

    override fun youtubeApiKey(): String? = prefs.getString(KEY_YOUTUBE, null)?.takeIf { it.isNotBlank() }

    override fun redditClientId(): String? = prefs.getString(KEY_REDDIT, null)?.takeIf { it.isNotBlank() }

    fun setYouTubeApiKey(value: String) = prefs.edit().putString(KEY_YOUTUBE, value.trim()).apply()

    fun setRedditClientId(value: String) = prefs.edit().putString(KEY_REDDIT, value.trim()).apply()

    fun dropZone(): ZoneId = runCatching { ZoneId.of(prefs.getString(KEY_ZONE, null) ?: DEFAULT_ZONE) }
        .getOrDefault(ZoneId.of(DEFAULT_ZONE))

    fun setDropZone(zoneId: String) = prefs.edit().putString(KEY_ZONE, zoneId).apply()

    /**
     * `search.list` is metered in its own bucket capped at 100 calls/day, separate
     * from the 10,000-unit quota `videos.list` draws on. Three drops with one seed
     * query is 3 calls a day, but every extra configured query multiplies by
     * three -- so the ledger is enforced rather than assumed.
     *
     * The day boundary is Pacific because that is when Google resets the quota,
     * not when the user's day rolls over.
     */
    override suspend fun trySpend(): Boolean = synchronized(ledgerLock) {
        // Read-modify-write on the counter, so two feelers refreshing at once
        // cannot both see the same "used" value and overspend the bucket.
        // Nothing suspends inside the lock.
        val today = LocalDate.ofInstant(clock.instant(), QUOTA_RESET_ZONE).toString()
        val storedDay = prefs.getString(KEY_SEARCH_DAY, null)
        val used = if (storedDay == today) prefs.getInt(KEY_SEARCH_USED, 0) else 0

        if (used >= YOUTUBE_SEARCH_CALLS_PER_DAY) return@synchronized false

        prefs.edit()
            .putString(KEY_SEARCH_DAY, today)
            .putInt(KEY_SEARCH_USED, used + 1)
            .commit()
        true
    }

    fun searchCallsUsedToday(): Int {
        val today = LocalDate.ofInstant(clock.instant(), QUOTA_RESET_ZONE).toString()
        return if (prefs.getString(KEY_SEARCH_DAY, null) == today) prefs.getInt(KEY_SEARCH_USED, 0) else 0
    }

    private companion object {
        const val KEY_YOUTUBE = "youtube_api_key"
        const val KEY_REDDIT = "reddit_client_id"
        const val KEY_ZONE = "drop_zone"
        const val KEY_SEARCH_DAY = "search_day"
        const val KEY_SEARCH_USED = "search_used"

        const val DEFAULT_ZONE = "America/Denver"

        /** Google's documented ceiling for the Search Queries bucket. */
        const val YOUTUBE_SEARCH_CALLS_PER_DAY = 100

        val QUOTA_RESET_ZONE: ZoneId = ZoneId.of("America/Los_Angeles")
    }
}
