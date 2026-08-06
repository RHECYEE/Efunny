package com.rhecyee.efunny.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.data.SourceConfigEntity

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SourcesScreen(
    onBack: () -> Unit,
    viewModel: SourcesViewModel = viewModel(),
) {
    val sources by viewModel.sources.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Sources") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { KeysCard(viewModel) }
            item { AddSourceCard(viewModel) }

            item {
                Text(
                    "Sources",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }

            items(sources, key = { it.id }) { source ->
                SourceRow(source, viewModel)
            }

            item {
                Button(onClick = { viewModel.runDropNow() }, modifier = Modifier.fillMaxWidth()) {
                    Text("Run a drop now")
                }
            }
        }
    }
}

@Composable
private fun KeysCard(viewModel: SourcesViewModel) {
    var youtube by remember { mutableStateOf(viewModel.youtubeKey()) }
    var reddit by remember { mutableStateOf(viewModel.redditClientId()) }
    var zone by remember { mutableStateOf(viewModel.dropZone()) }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("Keys", style = MaterialTheme.typography.titleMedium)
            Text(
                "Stored encrypted on this device only. Feed sources work without any keys at all.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp, bottom = 12.dp),
            )

            OutlinedTextField(
                value = youtube,
                onValueChange = { youtube = it; viewModel.setYouTubeKey(it) },
                label = { Text("YouTube Data API key") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Search calls used today: ${viewModel.searchCallsUsedToday()} of 100",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )

            OutlinedTextField(
                value = reddit,
                onValueChange = { reddit = it; viewModel.setRedditClientId(it) },
                label = { Text("Reddit client ID (installed app)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )

            OutlinedTextField(
                value = zone,
                onValueChange = { zone = it },
                label = { Text("Drop time zone") },
                supportingText = { Text("Drops fire at 05:00, 15:00 and 20:00 in this zone") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            )
            Button(
                onClick = { viewModel.setDropZone(zone) },
                modifier = Modifier.padding(top = 8.dp),
            ) { Text("Apply time zone") }
        }
    }
}

@Composable
private fun AddSourceCard(viewModel: SourcesViewModel) {
    var feedName by remember { mutableStateOf("") }
    var feedUrl by remember { mutableStateOf("") }
    var useDescription by remember { mutableStateOf(false) }
    var subreddit by remember { mutableStateOf("") }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("Add a source", style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = feedName,
                onValueChange = { feedName = it },
                label = { Text("Site name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            OutlinedTextField(
                value = feedUrl,
                onValueChange = { feedUrl = it },
                label = { Text("RSS or Atom feed URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
                Switch(checked = useDescription, onCheckedChange = { useDescription = it })
                Text(
                    "Content is in the description, not the title",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
            Button(
                onClick = {
                    if (feedUrl.isNotBlank()) {
                        viewModel.addRssSource(feedName, feedUrl, useDescription)
                        feedName = ""; feedUrl = ""; useDescription = false
                    }
                },
                modifier = Modifier.padding(top = 8.dp),
            ) { Text("Add feed") }

            HorizontalDivider(Modifier.padding(vertical = 12.dp))

            OutlinedTextField(
                value = subreddit,
                onValueChange = { subreddit = it },
                label = { Text("Subreddit") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = {
                    if (subreddit.isNotBlank()) { viewModel.addSubreddit(subreddit); subreddit = "" }
                },
                modifier = Modifier.padding(top = 8.dp),
            ) { Text("Add subreddit") }
        }
    }
}

@Composable
private fun SourceRow(source: SourceConfigEntity, viewModel: SourcesViewModel) {
    val closed = source.type in CLOSED_TYPES

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        source.displayName,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Medium,
                    )
                    Text(
                        source.params["url"] ?: source.params["subreddit"]?.let { "r/$it" }
                            ?: source.params["query"] ?: source.type,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = source.enabled,
                    // The three closed platforms cannot be switched on: there is
                    // no API behind them to enable.
                    enabled = !closed,
                    onCheckedChange = { viewModel.setEnabled(source, it) },
                )
                IconButton(onClick = { viewModel.delete(source) }) {
                    Icon(Icons.Default.Delete, contentDescription = "Remove ${source.displayName}")
                }
            }

            source.lastResult?.let { result ->
                Text(
                    result,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (result.startsWith("OK")) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                    modifier = Modifier.padding(top = 6.dp),
                )
            }

            if (closed) {
                Text(
                    CLOSED_REASONS[source.type].orEmpty(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

private val CLOSED_TYPES = setOf(
    SourceType.INSTAGRAM_REELS.name,
    SourceType.TIKTOK.name,
    SourceType.FACEBOOK_GROUP.name,
)

/**
 * Stated plainly in the UI so the empty slots read as a platform decision rather
 * than a bug in the app.
 */
private val CLOSED_REASONS = mapOf(
    SourceType.INSTAGRAM_REELS.name to
        "Needs a server: the Meta app secret cannot ship inside an APK",
    SourceType.TIKTOK.name to
        "No public API: the Research API is academic-only and the Display API is self-only",
    SourceType.FACEBOOK_GROUP.name to
        "Meta removed the Groups API from all Graph API versions on 22 Apr 2024",
)
