package com.rhecyee.efunny.core.feelers

/**
 * Supplies the keys feelers need.
 *
 * Nothing is compiled into the APK: the app implements this over
 * EncryptedSharedPreferences and the user pastes their own keys in Settings.
 * That sidesteps key extraction from a shipped binary entirely, and means each
 * install spends its own quota rather than everyone sharing one rate limit.
 */
interface Credentials {
    fun youtubeApiKey(): String?
    fun redditClientId(): String?
}

/** A budget for API calls that are metered separately from ordinary quota. */
interface SearchBudget {
    /** Returns false when today's allowance is spent, so the feeler can stand down cleanly. */
    suspend fun trySpend(): Boolean
}

/** Always allows the call. Used in tests and by feelers with no metered bucket. */
object UnlimitedSearchBudget : SearchBudget {
    override suspend fun trySpend(): Boolean = true
}
