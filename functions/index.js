const {
    onDocumentUpdated,
    onDocumentCreated,
    onDocumentDeleted,
} = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { getStorage } = require('firebase-admin/storage');

const WEB_ORIGIN = ['https://www.tuprofeappmovil.com', 'https://tuprofe-89d43.web.app'];

const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// --- Helpers ---

function getFcmToken(data) {
    return data?.fcmtoken || data?.FCMToken || null;
}

function checkPref(userData, prefKey) {
    const prefs = userData?.notifPrefs;
    if (!prefs) return true;
    return prefs[prefKey] !== false;
}

async function saveNotification(recipientId, notifData) {
    await db.collection("users").doc(recipientId)
        .collection("notifications")
        .add({
            ...notifData,
            read: false,
            createdAt: FieldValue.serverTimestamp(),
        });
}

function buildLocMessage(token, notification, data, titleLocKey, titleLocArgs) {
    return {
        token,
        notification,
        data,
        android: {
            notification: {
                titleLocKey,
                ...(titleLocArgs && { titleLocArgs }),
            },
        },
        apns: {
            payload: {
                aps: {
                    alert: {
                        titleLocKey,
                        ...(titleLocArgs && { titleLocArgs }),
                    },
                },
            },
        },
    };
}

async function sendPushAndSave(token, notification, data, recipientId, notifData) {
    const { titleLocKey, titleLocArgs } = notifData;
    const message = titleLocKey
        ? buildLocMessage(token, notification, data, titleLocKey, titleLocArgs)
        : { token, notification, data };
    try {
        await admin.messaging().send(message);
        logger.log("Notificación enviada a:", recipientId);
    } catch (error) {
        logger.error("Error al enviar notificación FCM:", error);
    }
    await saveNotification(recipientId, notifData);
}

async function dispatchNotification(recipientId, userData, prefKey, notification, fcmData, notifData) {
    const token = getFcmToken(userData);
    const fullNotifData = { ...notifData, title: notification.title, body: notification.body };
    if (checkPref(userData, prefKey) && token) {
        await sendPushAndSave(token, notification, fcmData, recipientId, fullNotifData);
    } else {
        await saveNotification(recipientId, fullNotifData);
    }
}

async function batchChunked(items, size, fn) {
    for (let i = 0; i < items.length; i += size) {
        const batch = db.batch();
        items.slice(i, i + size).forEach(item => fn(batch, item));
        await batch.commit();
    }
}

const RECONCILE_BATCH = 20;

async function reconcileOne(reviewDoc) {
    const reviewId  = reviewDoc.id;
    const reviewRef = db.collection("reviews").doc(reviewId);
    const data      = reviewDoc.data();

    const [likesCountSnap, commentsCountSnap] = await Promise.all([
        reviewRef.collection("likes").count().get(),
        db.collection("comments")
            .where("reviewId", "==", reviewId)
            .where("parentCommentId", "==", null)
            .count()
            .get(),
    ]);

    const actualLikes    = likesCountSnap.data().count;
    const actualComments = commentsCountSnap.data().count;
    const storedLikes    = data.likesCount ?? 0;
    const storedComments = data.comment    ?? 0;

    if (actualLikes === storedLikes && actualComments === storedComments) return false;

    const update = {};
    if (actualLikes    !== storedLikes)    update.likesCount = actualLikes;
    if (actualComments !== storedComments) update.comment    = actualComments;

    await reviewRef.update(update);
    logger.log(`[reconcile] Fixed review ${reviewId}:`, update);
    return true;
}

// --- Data sync functions ---

exports.updateUserInfoInReviews = onDocumentUpdated(
    "users/{userId}",
    async (event) => {
        const userId = event.params.userId;
        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();

        if (beforeData.username === afterData.username) {
            logger.log("No change in username, skipping update.");
            return;
        }

        logger.log("Actualizando reviews del usuario:", userId);

        const reviewsSnapshot = await db
            .collection("reviews")
            .where("userId", "==", userId)
            .get();

        const batch = db.batch();
        reviewsSnapshot.forEach((doc) => {
            batch.update(doc.ref, { "user.username": afterData.username });
        });

        await batch.commit();
        logger.log("Reviews actualizadas para el usuario:", userId);
    }
);

exports.updateProfessorInfoInReviews = onDocumentUpdated(
    "professors/{professorId}",
    async (event) => {
        const professorId = event.params.professorId;
        const before = event.data.before.data();
        const after = event.data.after.data();

        const infoChanged =
            before.name !== after.name ||
            before.foto_prof !== after.foto_prof ||
            before.department !== after.department;

        const beforeSubjects = before.subjects || [];
        const afterSubjects  = after.subjects  || [];
        const afterSet       = new Set(afterSubjects);
        const beforeSet      = new Set(beforeSubjects);
        const removed        = beforeSubjects.filter(s => !afterSet.has(s));
        const added          = afterSubjects.filter(s => !beforeSet.has(s));
        // Only handle unambiguous 1-to-1 renames
        const subjectsRenamed = removed.length === 1 && added.length === 1;

        if (!infoChanged && !subjectsRenamed) return;

        const tasks = [];

        if (infoChanged) {
            tasks.push((async () => {
                const snap = await db.collection("reviews")
                    .where("professorId", "==", professorId)
                    .get();
                if (snap.empty) return;
                const batch = db.batch();
                snap.forEach(doc => batch.update(doc.ref, {
                    "professor.name":       after.name,
                    "professor.foto_prof":  after.foto_prof,
                    "professor.department": after.department,
                }));
                await batch.commit();
                logger.log("Reviews actualizadas (info) para profesor:", professorId);
            })());
        }

        if (subjectsRenamed) {
            const [oldName, newName] = [removed[0], added[0]];
            tasks.push((async () => {
                const snap = await db.collection("reviews")
                    .where("professorId", "==", professorId)
                    .where("materia", "==", oldName)
                    .get();
                if (snap.empty) return;
                const batch = db.batch();
                snap.forEach(doc => batch.update(doc.ref, { materia: newName }));
                await batch.commit();
                logger.log(`[materias] "${oldName}" → "${newName}" en ${snap.size} reseñas del profesor ${professorId}`);
            })());
        }

        await Promise.all(tasks);
    }
);

// --- Notification functions ---

exports.onLikeCreated = onDocumentCreated(
    "reviews/{reviewId}/likes/{likeId}",
    async (event) => {
        const reviewId = event.params.reviewId;
        const likerId = event.params.likeId;

        const reviewSnap = await db.collection("reviews").doc(reviewId).get();
        if (!reviewSnap.exists) {
            logger.log("Review no encontrado:", reviewId);
            return;
        }

        const review = reviewSnap.data();
        const authorId = review.user?.userId || review.userId;
        if (!authorId || likerId === authorId) return;

        const [authorSnap, likerSnap] = await Promise.all([
            db.collection("users").doc(authorId).get(),
            db.collection("users").doc(likerId).get(),
        ]);

        if (!authorSnap.exists) return;

        const likerUsername = likerSnap.data()?.username || "Alguien";
        const professorName = review.professor?.name || "un profesor";

        await dispatchNotification(
            authorId,
            authorSnap.data(),
            "likes",
            {
                title: "¡Le dieron like a tu reseña!",
                body: `${likerUsername} le dio like a tu reseña de ${professorName}`,
            },
            { reviewId, type: "like" },
            { type: "like", fromUserId: likerId, fromUsername: likerUsername, reviewId, commentId: null, titleLocKey: "notif_like_title", titleLocArgs: [likerUsername] }
        );
    }
);

exports.onCommentCreated = onDocumentCreated(
    "comments/{commentId}",
    async (event) => {
        const commentId = event.params.commentId;
        const comment = event.data.data();
        const { userId: commenterId, reviewId, parentCommentId } = comment;
        const commenterUsername = comment.user?.username || "Alguien";

        if (!reviewId) return;

        const reviewSnap = await db.collection("reviews").doc(reviewId).get();
        if (!reviewSnap.exists) return;

        const review = reviewSnap.data();
        const reviewAuthorId = review.user?.userId || review.userId;
        const professorName = review.professor?.name || "un profesor";

        if (reviewAuthorId && commenterId !== reviewAuthorId) {
            const authorSnap = await db.collection("users").doc(reviewAuthorId).get();
            if (authorSnap.exists) {
                await dispatchNotification(
                    reviewAuthorId,
                    authorSnap.data(),
                    "comentarios",
                    {
                        title: "Nuevo comentario en tu reseña",
                        body: `${commenterUsername} comentó en tu reseña de ${professorName}`,
                    },
                    { reviewId, commentId, type: "comment" },
                    { type: "comment", fromUserId: commenterId, fromUsername: commenterUsername, reviewId, commentId, titleLocKey: "notif_comment_title", titleLocArgs: [commenterUsername] }
                );
            }
        }

        if (parentCommentId) {
            const parentSnap = await db.collection("comments").doc(parentCommentId).get();
            if (parentSnap.exists) {
                const parentAuthorId = parentSnap.data()?.userId;
                if (parentAuthorId && parentAuthorId !== commenterId && parentAuthorId !== reviewAuthorId) {
                    const parentAuthorSnap = await db.collection("users").doc(parentAuthorId).get();
                    if (parentAuthorSnap.exists) {
                        await dispatchNotification(
                            parentAuthorId,
                            parentAuthorSnap.data(),
                            "comentarios",
                            {
                                title: "Respondieron tu comentario",
                                body: `${commenterUsername} respondió tu comentario`,
                            },
                            { reviewId, commentId, type: "reply" },
                            { type: "reply", fromUserId: commenterId, fromUsername: commenterUsername, reviewId, commentId, titleLocKey: "notif_reply_title", titleLocArgs: [commenterUsername] }
                        );
                    }
                }
            }
        }
    }
);

exports.onFollowCreated = onDocumentCreated(
    "users/{userId}/followers/{followerId}",
    async (event) => {
        const userId = event.params.userId;
        const followerId = event.params.followerId;

        const [recipientSnap, followerSnap] = await Promise.all([
            db.collection("users").doc(userId).get(),
            db.collection("users").doc(followerId).get(),
        ]);

        if (!recipientSnap.exists) return;

        const followerUsername = followerSnap.data()?.username || "Alguien";

        await dispatchNotification(
            userId,
            recipientSnap.data(),
            "seguidores",
            {
                title: "¡Tienes un nuevo seguidor!",
                body: `${followerUsername} empezó a seguirte`,
            },
            { followerId, type: "follow" },
            { type: "follow", fromUserId: followerId, fromUsername: followerUsername, reviewId: null, commentId: null, titleLocKey: "notif_follow_title", titleLocArgs: [followerUsername] }
        );
    }
);

exports.onUserAccountDeleted = onDocumentDeleted(
    "users/{userId}",
    async (event) => {
        const userId = event.params.userId;
        const CHUNK = 200;

        logger.log("Iniciando limpieza de cuenta:", userId);

        const storageDelete = getStorage().bucket()
            .file(`profileImages/${userId}.jpg`)
            .delete()
            .catch(() => logger.warn("Sin imagen de perfil para:", userId));

        const [reviewsSnap, commentsSnap, followersSnap, followingSnap, allLikesSnap] = await Promise.all([
            db.collection("reviews").where("userId", "==", userId).get(),
            db.collection("comments").where("userId", "==", userId).get(),
            db.collection("users").doc(userId).collection("followers").get(),
            db.collection("users").doc(userId).collection("following").get(),
            db.collectionGroup("likes").get(),
        ]);

        const userReviewIds = new Set(reviewsSnap.docs.map(d => d.id));
        const userCommentIds = new Set(commentsSnap.docs.map(d => d.id));
        // like documents use the userId as their document ID (no queryable userId field)
        const userLikeDocs = allLikesSnap.docs.filter(doc => doc.id === userId);

        const relationOps = [
            ...followersSnap.docs.map(doc => ({ type: "follower", otherId: doc.id })),
            ...followingSnap.docs.map(doc => ({ type: "following", otherId: doc.id })),
        ];

        await Promise.all([
            storageDelete,

            Promise.all(reviewsSnap.docs.map(doc => db.recursiveDelete(doc.ref))),

            (async () => {
                if (commentsSnap.empty) return;
                await batchChunked(commentsSnap.docs, CHUNK, (batch, doc) => {
                    const data = doc.data();
                    if (data.reviewId && !userReviewIds.has(data.reviewId))
                        batch.update(db.collection("reviews").doc(data.reviewId), { comment: FieldValue.increment(-1) });
                    if (data.parentCommentId && !userCommentIds.has(data.parentCommentId))
                        batch.update(db.collection("comments").doc(data.parentCommentId), { repliesCount: FieldValue.increment(-1) });
                });
                await Promise.all(commentsSnap.docs.map(doc => db.recursiveDelete(doc.ref)));
            })(),

            batchChunked(relationOps, CHUNK, (batch, { type, otherId }) => {
                if (type === "follower") {
                    batch.delete(db.collection("users").doc(otherId).collection("following").doc(userId));
                    batch.update(db.collection("users").doc(otherId), { followingCount: FieldValue.increment(-1) });
                } else {
                    batch.delete(db.collection("users").doc(otherId).collection("followers").doc(userId));
                    batch.update(db.collection("users").doc(otherId), { followersCount: FieldValue.increment(-1) });
                }
            }),

            batchChunked(userLikeDocs, CHUNK, (batch, doc) => {
                batch.delete(doc.ref);
                batch.update(doc.ref.parent.parent, { likesCount: FieldValue.increment(-1) });
            }),

            Promise.all([
                db.recursiveDelete(db.collection("users").doc(userId).collection("followers")),
                db.recursiveDelete(db.collection("users").doc(userId).collection("following")),
                db.recursiveDelete(db.collection("users").doc(userId).collection("notifications")),
            ]),
        ]);

        logger.log("Limpieza completada para usuario:", userId);
    }
);

exports.reconcileReviewCounters = onSchedule(
    {
        schedule: "every 24 hours",
        timeZone: "America/Bogota",
        timeoutSeconds: 540,
        memory: "512MiB",
        retryCount: 0,
    },
    async (_event) => {
        const reviewsSnap = await db.collection("reviews")
            .select("likesCount", "comment")
            .get();
        const reviewDocs = reviewsSnap.docs;
        logger.log(`[reconcileReviewCounters] Checking ${reviewDocs.length} reviews`);

        let fixed = 0;
        for (let i = 0; i < reviewDocs.length; i += RECONCILE_BATCH) {
            const results = await Promise.all(
                reviewDocs.slice(i, i + RECONCILE_BATCH).map(reconcileOne)
            );
            fixed += results.filter(Boolean).length;
        }
        logger.log(`[reconcileReviewCounters] Done. Fixed: ${fixed}/${reviewDocs.length}`);
    }
);

// Aggregates counter decrements per parent document to avoid duplicate-doc-in-batch errors.
// skip(doc, ref) → true means skip this doc from the aggregation.
function aggregateDecrements(docs, getRef, skip) {
    const map = new Map();
    for (const doc of docs) {
        const ref = getRef(doc);
        if (skip && skip(doc, ref)) continue;
        const p = ref.path;
        if (!map.has(p)) map.set(p, { ref, n: 0 });
        map.get(p).n++;
    }
    return [...map.values()];
}

exports.cleanupOrphanedData = onSchedule(
    {
        schedule: "every 24 hours",
        timeZone: "America/Bogota",
        timeoutSeconds: 540,
        memory: "512MiB",
        retryCount: 0,
    },
    async (_event) => {
        // Phase 1: Load all data needed for orphan detection
        const [usersSnap, reviewsSnap, commentsSnap, allLikesSnap, allFollowersSnap, allFollowingSnap] =
            await Promise.all([
                db.collection("users").get(),
                db.collection("reviews").select("userId").get(),
                db.collection("comments").select("userId", "reviewId", "parentCommentId").get(),
                db.collectionGroup("likes").get(),
                db.collectionGroup("followers").get(),
                db.collectionGroup("following").get(),
            ]);

        const validIds = new Set(usersSnap.docs.map(d => d.id));

        // Phase 2: Find orphaned documents
        // For likes/followers/following the doc.id IS the referenced userId
        const orphanedReviews   = reviewsSnap.docs.filter(d => !validIds.has(d.data().userId));
        const orphanedComments  = commentsSnap.docs.filter(d => !validIds.has(d.data().userId));
        const orphanedLikes     = allLikesSnap.docs.filter(d => !validIds.has(d.id));
        // Also orphaned if the parent user no longer exists
        const orphanedFollowers = allFollowersSnap.docs.filter(d =>
            !validIds.has(d.id) || !validIds.has(d.ref.parent.parent.id)
        );
        const orphanedFollowing = allFollowingSnap.docs.filter(d =>
            !validIds.has(d.id) || !validIds.has(d.ref.parent.parent.id)
        );

        const total = orphanedReviews.length + orphanedComments.length + orphanedLikes.length +
                      orphanedFollowers.length + orphanedFollowing.length;

        logger.log(`[cleanupOrphanedData] reviews:${orphanedReviews.length} comments:${orphanedComments.length} likes:${orphanedLikes.length} followers:${orphanedFollowers.length} following:${orphanedFollowing.length}`);
        if (total === 0) return;

        const orphanedReviewIds  = new Set(orphanedReviews.map(d => d.id));
        const orphanedCommentIds = new Set(orphanedComments.map(d => d.id));

        // Phase 3: Aggregate counter decrements per parent doc (avoids duplicate writes in same batch)
        const commentDecrs = aggregateDecrements(
            orphanedComments,
            doc => db.collection("reviews").doc(doc.data().reviewId),
            doc => !doc.data().reviewId || orphanedReviewIds.has(doc.data().reviewId)
        );
        const replyDecrs = aggregateDecrements(
            orphanedComments,
            doc => db.collection("comments").doc(doc.data().parentCommentId),
            doc => !doc.data().parentCommentId || orphanedCommentIds.has(doc.data().parentCommentId)
        );
        const likeDecrs = aggregateDecrements(
            orphanedLikes,
            doc => doc.ref.parent.parent,
            (doc, ref) => ref.parent.id === "reviews"
                ? orphanedReviewIds.has(ref.id)
                : orphanedCommentIds.has(ref.id)
        );
        // Only decrement if the parent user still exists
        const followerDecrs = aggregateDecrements(
            orphanedFollowers,
            doc => doc.ref.parent.parent,
            (doc, ref) => !validIds.has(ref.id)
        );
        const followingDecrs = aggregateDecrements(
            orphanedFollowing,
            doc => doc.ref.parent.parent,
            (doc, ref) => !validIds.has(ref.id)
        );

        // Phase 4: Delete orphans and update counters in parallel
        await Promise.all([
            Promise.all(orphanedReviews.map(doc => db.recursiveDelete(doc.ref))),
            Promise.all(orphanedComments.map(doc => db.recursiveDelete(doc.ref))),
            batchChunked(orphanedLikes,     500, (batch, doc) => batch.delete(doc.ref)),
            batchChunked(orphanedFollowers, 500, (batch, doc) => batch.delete(doc.ref)),
            batchChunked(orphanedFollowing, 500, (batch, doc) => batch.delete(doc.ref)),
            batchChunked(commentDecrs,   500, (batch, { ref, n }) => batch.update(ref, { comment:        FieldValue.increment(-n) })),
            batchChunked(replyDecrs,     500, (batch, { ref, n }) => batch.update(ref, { repliesCount:   FieldValue.increment(-n) })),
            batchChunked(likeDecrs,      500, (batch, { ref, n }) => batch.update(ref, { likesCount:     FieldValue.increment(-n) })),
            batchChunked(followerDecrs,  500, (batch, { ref, n }) => batch.update(ref, { followersCount: FieldValue.increment(-n) })),
            batchChunked(followingDecrs, 500, (batch, { ref, n }) => batch.update(ref, { followingCount: FieldValue.increment(-n) })),
        ]);

        logger.log("[cleanupOrphanedData] Cleanup complete.");
    }
);

exports.reconcileMateriaInReviews = onSchedule(
    {
        schedule: "every 24 hours",
        timeZone: "America/Bogota",
        timeoutSeconds: 540,
        memory: "256MiB",
        retryCount: 0,
    },
    async (_event) => {
        const [professorsSnap, reviewsSnap] = await Promise.all([
            db.collection("professors").select("subjects").get(),
            db.collection("reviews").select("professorId", "materia").get(),
        ]);

        const profSubjects = new Map();
        for (const doc of professorsSnap.docs) {
            profSubjects.set(doc.id, new Set(doc.data().subjects || []));
        }

        const invalidReviews = reviewsSnap.docs.filter(doc => {
            const { professorId, materia } = doc.data();
            if (!professorId || !materia) return true;
            const subjects = profSubjects.get(professorId);
            if (!subjects) return false;
            return !subjects.has(materia);
        });

        logger.log(`[reconcileMateriaInReviews] Invalid: ${invalidReviews.length}/${reviewsSnap.size}`);
        if (!invalidReviews.length) return;

        const invalidReviewIds = invalidReviews.map(d => d.id);

        // Fetch all comments on invalid reviews (in parallel chunks of 30)
        const commentSnaps = await Promise.all(
            Array.from({ length: Math.ceil(invalidReviewIds.length / 30) }, (_, i) =>
                db.collection("comments")
                    .where("reviewId", "in", invalidReviewIds.slice(i * 30, i * 30 + 30))
                    .get()
            )
        );
        const commentDocs = commentSnaps.flatMap(s => s.docs);

        // recursiveDelete handles likes subcollections on both reviews and comments
        await Promise.all([
            Promise.all(invalidReviews.map(doc => db.recursiveDelete(doc.ref))),
            Promise.all(commentDocs.map(doc => db.recursiveDelete(doc.ref))),
        ]);
        logger.log(`[reconcileMateriaInReviews] Deleted ${invalidReviews.length} reviews and ${commentDocs.length} comments.`);
    }
);

exports.cleanupUnverifiedUsers = onSchedule(
    {
        schedule: "every 24 hours",
        timeZone: "America/Bogota",
        timeoutSeconds: 540,
        memory: "256MiB",
        retryCount: 0,
    },
    async (_event) => {
        // Paginate through all Firebase Auth users and collect unverified UIDs
        const unverifiedUids = [];
        let pageToken;
        do {
            const result = await admin.auth().listUsers(1000, pageToken);
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            for (const user of result.users) {
                if (!user.emailVerified && new Date(user.metadata.creationTime).getTime() < cutoff)
                    unverifiedUids.push(user.uid);
            }
            pageToken = result.pageToken;
        } while (pageToken);

        logger.log(`[cleanupUnverifiedUsers] Found ${unverifiedUids.length} unverified users`);
        if (!unverifiedUids.length) return;

        await Promise.all([
            // Deleting the Firestore doc triggers onUserAccountDeleted for full data cleanup
            batchChunked(unverifiedUids, 500, (batch, uid) =>
                batch.delete(db.collection("users").doc(uid))
            ),
            // Delete Auth accounts in chunks of 1000 (max per deleteUsers call)
            (async () => {
                for (let i = 0; i < unverifiedUids.length; i += 1000) {
                    const { failureCount, errors } = await admin.auth().deleteUsers(
                        unverifiedUids.slice(i, i + 1000)
                    );
                    if (failureCount > 0)
                        errors.forEach(e => logger.error("[cleanupUnverifiedUsers] Auth error:", e.error));
                }
            })(),
        ]);

        logger.log(`[cleanupUnverifiedUsers] Deleted ${unverifiedUids.length} unverified users`);
    }
);

exports.onBlockCreated = onDocumentCreated(
    "blocks/{blockId}",
    async (event) => {
        const { blockerId, blockedId } = event.data.data();
        if (!blockerId || !blockedId) return;

        const blockerRef = db.collection("users").doc(blockerId);
        const blockedRef = db.collection("users").doc(blockedId);

        // Check both follow directions in parallel
        const [aFollowsB, bFollowsA] = await Promise.all([
            blockerRef.collection("following").doc(blockedId).get(),
            blockedRef.collection("following").doc(blockerId).get(),
        ]);

        if (!aFollowsB.exists && !bFollowsA.exists) return;

        const batch = db.batch();

        if (aFollowsB.exists) {
            batch.delete(blockerRef.collection("following").doc(blockedId));
            batch.delete(blockedRef.collection("followers").doc(blockerId));
            batch.update(blockerRef, { followingCount: FieldValue.increment(-1) });
            batch.update(blockedRef, { followersCount: FieldValue.increment(-1) });
        }

        if (bFollowsA.exists) {
            batch.delete(blockedRef.collection("following").doc(blockerId));
            batch.delete(blockerRef.collection("followers").doc(blockedId));
            batch.update(blockedRef, { followingCount: FieldValue.increment(-1) });
            batch.update(blockerRef, { followersCount: FieldValue.increment(-1) });
        }

        await batch.commit();
        logger.log(`[onBlockCreated] Removed follow(s) between ${blockerId} and ${blockedId}`);
    }
);

exports.onReportCreated = onDocumentCreated(
    "reports/{reportId}",
    async (event) => {
        const report = event.data.data();
        const { targetId, targetType } = report;

        if (targetType !== "review") return;

        const countSnap = await db.collection("reports")
            .where("targetId", "==", targetId)
            .where("targetType", "==", "review")
            .count()
            .get();

        if (countSnap.data().count < 5) return;

        const reviewRef = db.collection("reviews").doc(targetId);
        const reviewSnap = await reviewRef.get();
        if (!reviewSnap.exists) return;

        const review = reviewSnap.data();
        const authorId = review.user?.userId || review.userId;
        const professorName = review.professor?.name || "un profesor";

        const commentsSnap = await db.collection("comments")
            .where("reviewId", "==", targetId)
            .get();

        await Promise.all([
            db.recursiveDelete(reviewRef),
            ...commentsSnap.docs.map(doc => db.recursiveDelete(doc.ref)),
        ]);

        logger.log(`[onReportCreated] Deleted review ${targetId} (5+ reports)`);

        if (!authorId) return;
        const authorSnap = await db.collection("users").doc(authorId).get();
        if (!authorSnap.exists) return;

        await dispatchNotification(
            authorId,
            authorSnap.data(),
            "reportes",
            {
                title: "Tu reseña fue eliminada",
                body: `Tu reseña de ${professorName} fue eliminada por violar las normas de la comunidad.`,
            },
            { type: "reviewDeleted" },
            { type: "reviewDeleted", reviewId: targetId, fromUserId: null, fromUsername: null, commentId: null, titleLocKey: "notif_review_deleted_title", titleLocArgs: null }
        );
    }
);

exports.confirmAccountDeletion = onRequest(
    { region: 'us-central1', cors: WEB_ORIGIN },
    async (req, res) => {
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        const authHeader = req.headers.authorization || '';
        const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

        const { username } = req.body;

        try {
            const decoded = await admin.auth().verifyIdToken(idToken);
            const uid = decoded.uid;

            if (username) {
                const userDoc = await db.collection('users').doc(uid).get();
                if (!userDoc.exists || userDoc.data().username !== username) {
                    return res.status(403).json({ error: 'Username mismatch' });
                }
            }

            await db.collection('users').doc(uid).delete();
            await admin.auth().deleteUser(uid);

            logger.log('Account deleted via email link for uid:', uid);
            return res.status(200).json({ success: true });
        } catch (err) {
            logger.error('confirmAccountDeletion error:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
    }
);
