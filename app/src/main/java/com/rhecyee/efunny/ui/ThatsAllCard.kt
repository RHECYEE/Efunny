package com.rhecyee.efunny.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.Canvas
import com.rhecyee.efunny.core.schedule.DropSchedule
import com.rhecyee.efunny.core.spotlight.SpotlightSpec
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant

private val Amber = Color(0xFFF5B841)
private val CardBackground = Color(0xFF2B2B2B)
private val BodyText = Color(0xFFE8E8E8)

/**
 * The end-of-spotlight card.
 *
 * Sits after the last post so the feed has a definite bottom -- the point of a
 * fixed daily set is that it *ends*, and an infinite-scroll shaped feed would
 * undercut that. The countdown gives the run-out somewhere to go.
 */
@Composable
fun ThatsAllCard(
    schedule: DropSchedule?,
    modifier: Modifier = Modifier,
) {
    // Recomputing the next drop each tick keeps the card correct across the
    // moment a drop fires: the countdown hits zero and rolls straight on to the
    // following slot without needing to be told.
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            now = Instant.now()
        }
    }

    val nextDropAt = remember(schedule, now.epochSecond / 30) {
        schedule?.nextAfter(now)?.at
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(CardBackground)
            .padding(vertical = 32.dp, horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = "THAT'S ALL!",
            color = Amber,
            fontSize = 34.sp,
            fontWeight = FontWeight.ExtraBold,
            letterSpacing = 2.sp,
            textAlign = TextAlign.Center,
        )

        SmileyFace(Modifier.size(132.dp))

        Text(
            text = "You've reached your spotlight limit of " +
                "${SpotlightSpec.POSTS_PER_DAY} social media posts.",
            color = BodyText,
            fontSize = 16.sp,
            textAlign = TextAlign.Center,
            lineHeight = 22.sp,
        )

        if (nextDropAt != null) {
            Text(
                text = "NEXT DROP IN",
                color = BodyText.copy(alpha = 0.6f),
                fontSize = 12.sp,
                letterSpacing = 2.sp,
                fontWeight = FontWeight.Medium,
            )
            Text(
                text = countdown(now, nextDropAt),
                color = Amber,
                fontSize = 30.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

/**
 * Formats the gap as HH:MM:SS. Monospaced at the call site so the digits do not
 * jitter as they change once a second.
 */
private fun countdown(now: Instant, target: Instant): String {
    val remaining = Duration.between(now, target).coerceAtLeast(Duration.ZERO)
    val hours = remaining.toHours()
    val minutes = remaining.toMinutes() % 60
    val seconds = remaining.seconds % 60
    return "%02d:%02d:%02d".format(hours, minutes, seconds)
}

/**
 * Drawn rather than shipped as a bitmap: it stays crisp at any density and adds
 * nothing to the APK.
 */
@Composable
private fun SmileyFace(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val d = size.minDimension
        val r = d * 0.40f
        val c = Offset(size.width / 2f, size.height / 2f)

        // Loose hand-drawn ring sitting just outside the face.
        drawCircle(
            color = Amber.copy(alpha = 0.35f),
            radius = d * 0.47f,
            center = c,
            style = Stroke(width = d * 0.035f),
        )

        drawCircle(color = Amber, radius = r, center = c)

        val eyeW = r * 0.20f
        val eyeH = r * 0.34f
        val eyeY = c.y - r * 0.32f
        listOf(-1f, 1f).forEach { side ->
            drawOval(
                color = CardBackground,
                topLeft = Offset(c.x + side * r * 0.38f - eyeW / 2f, eyeY - eyeH / 2f),
                size = Size(eyeW, eyeH),
            )
        }

        val smileBox = r * 1.05f
        drawArc(
            color = CardBackground,
            startAngle = 20f,
            sweepAngle = 140f,
            useCenter = false,
            topLeft = Offset(c.x - smileBox / 2f, c.y - smileBox / 2f + r * 0.06f),
            size = Size(smileBox, smileBox),
            style = Stroke(width = r * 0.13f, cap = StrokeCap.Round),
        )
    }
}
