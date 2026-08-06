package com.rhecyee.efunny.ui

import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.schedule.DropSlot
import com.rhecyee.efunny.data.SpotlightPost
import com.rhecyee.efunny.core.spotlight.SpotlightSpec
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SpotlightScreen(
    onOpenSources: () -> Unit,
    viewModel: SpotlightViewModel = viewModel(),
) {
    val state by viewModel.state.collectAsState()
    val schedule by viewModel.schedule.collectAsState()
    val context = LocalContext.current

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Spotlight") },
                actions = {
                    IconButton(onClick = { viewModel.refresh() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = onOpenSources) {
                        Icon(Icons.Default.Settings, contentDescription = "Sources")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {

            if (state.drops.isNotEmpty()) {
                DropSwitcher(state, viewModel::select)
            }

            state.selected?.let { DropHeader(it.compiledAt, state.posts.size, it.shortfall, it.backfilled) }

            when {
                state.refreshing && state.posts.isEmpty() -> Centered { CircularProgressIndicator() }

                state.posts.isEmpty() -> Centered {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("No drop yet", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "The next set compiles at 05:00, 15:00 or 20:00. " +
                                "Pull the refresh button to run one now.",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(top = 8.dp, start = 24.dp, end = 24.dp),
                        )
                    }
                }

                else -> LazyColumn(
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(state.posts, key = { it.id }) { post ->
                        PostCard(post) { open(context, post.permalink) }
                    }

                    // The set is finite by design, so the feed gets a definite
                    // bottom rather than trailing off like infinite scroll.
                    item(key = "thats-all") {
                        ThatsAllCard(
                            schedule = schedule,
                            modifier = Modifier.padding(top = 8.dp, bottom = 16.dp),
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DropSwitcher(state: SpotlightUiState, onSelect: (Long) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        state.drops.take(SpotlightSpec.DROPS_PER_DAY).forEach { drop ->
            val slot = runCatching { DropSlot.valueOf(drop.slot) }.getOrNull()
            FilterChip(
                selected = state.selected?.id == drop.id,
                onClick = { onSelect(drop.id) },
                label = { Text(slot?.label ?: drop.slot) },
            )
        }
    }
}

@Composable
private fun DropHeader(compiledAt: Long, count: Int, shortfall: Int, backfilled: Int) {
    val time = DateTimeFormatter.ofPattern("HH:mm", Locale.getDefault())
        .withZone(ZoneId.systemDefault())
        .format(Instant.ofEpochMilli(compiledAt))

    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(
            "$count posts - compiled $time",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // Say plainly when the set is short rather than quietly serving fewer
        // than promised.
        if (shortfall > 0) {
            Text(
                "$shortfall slot${if (shortfall == 1) "" else "s"} unfilled - every source came up dry",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.error,
            )
        } else if (backfilled > 0) {
            Text(
                "$backfilled backfilled from healthy sources",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PostCard(post: SpotlightPost, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {

            post.thumbnailUrl?.let { url ->
                AsyncImage(
                    model = url,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.size(72.dp).clip(RoundedCornerShape(8.dp)),
                )
            }

            Column(Modifier.padding(start = if (post.thumbnailUrl != null) 12.dp else 0.dp)) {
                Text(
                    post.title,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    maxLines = 4,
                )
                Row(
                    Modifier.padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AssistChip(
                        onClick = onClick,
                        label = { Text(post.sourceName, style = MaterialTheme.typography.labelSmall) },
                        colors = AssistChipDefaults.assistChipColors(),
                    )
                    Text(
                        "${age(post.publishedAt)} - ${engagementLabel(post)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}

/**
 * Feeds carry no engagement data, so those cards say "Latest" rather than
 * implying a trend signal the format cannot provide.
 */
private fun engagementLabel(post: SpotlightPost): String {
    val engagement = post.engagement
    if (engagement == null || post.sourceType == SourceType.RSS.name) return "Latest"
    return when {
        engagement >= 1_000_000 -> String.format(Locale.getDefault(), "%.1fM", engagement / 1_000_000)
        engagement >= 1_000 -> String.format(Locale.getDefault(), "%.1fk", engagement / 1_000)
        else -> engagement.toInt().toString()
    }
}

private fun age(publishedAt: Long): String {
    val hours = Duration.between(Instant.ofEpochMilli(publishedAt), Instant.now()).toHours()
    return when {
        hours < 1 -> "just now"
        hours == 1L -> "1h ago"
        else -> "${hours}h ago"
    }
}

/**
 * Posts open at the source in a Custom Tab. That keeps creator attribution and
 * view counts intact, which re-hosting the content in-app would not.
 */
private fun open(context: Context, url: String) {
    runCatching {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, Uri.parse(url))
    }
}
