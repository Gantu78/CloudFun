const {
    onDocumentUpdated,
    onDocumentCreated,
} = require('firebase-functions/v2/firestore');

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

async function sendPushAndSave(token, notification, data, recipientId, notifData) {
    try {
        await admin.messaging().send({ token, notification, data });
        logger.log("Notificación enviada a:", recipientId);
    } catch (error) {
        logger.error("Error al enviar notificación FCM:", error);
    }
    await saveNotification(recipientId, notifData);
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

        const changed =
            before.name !== after.name ||
            before.foto_prof !== after.foto_prof ||
            before.department !== after.department;

        if (!changed) return;

        const reviewsSnapshot = await db
            .collection("reviews")
            .where("professorId", "==", professorId)
            .get();

        if (reviewsSnapshot.empty) return;

        const batch = db.batch();
        reviewsSnapshot.forEach((doc) => {
            batch.update(doc.ref, {
                "professor.name": after.name,
                "professor.foto_prof": after.foto_prof,
                "professor.department": after.department,
            });
        });

        await batch.commit();
        logger.log("Reviews actualizadas para profesor:", professorId);
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

        const authorData = authorSnap.data();
        const likerUsername = likerSnap.data()?.username || "Alguien";
        const professorName = review.professor?.name || "un profesor";

        const notifData = {
            type: "like",
            fromUserId: likerId,
            fromUsername: likerUsername,
            reviewId,
            commentId: null,
        };

        if (!checkPref(authorData, "likes")) {
            await saveNotification(authorId, notifData);
            return;
        }

        const fcmToken = getFcmToken(authorData);
        if (!fcmToken) {
            await saveNotification(authorId, notifData);
            return;
        }

        await sendPushAndSave(
            fcmToken,
            {
                title: "¡Le dieron like a tu reseña!",
                body: `${likerUsername} le dio like a tu reseña de ${professorName}`,
            },
            { reviewId, type: "like" },
            authorId,
            notifData
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

        // Notify review author when someone comments on their review
        if (reviewAuthorId && commenterId !== reviewAuthorId) {
            const authorSnap = await db.collection("users").doc(reviewAuthorId).get();
            if (authorSnap.exists) {
                const authorData = authorSnap.data();
                const notifData = {
                    type: "comment",
                    fromUserId: commenterId,
                    fromUsername: commenterUsername,
                    reviewId,
                    commentId,
                };
                const fcmToken = getFcmToken(authorData);
                if (checkPref(authorData, "comentarios") && fcmToken) {
                    await sendPushAndSave(
                        fcmToken,
                        {
                            title: "Nuevo comentario en tu reseña",
                            body: `${commenterUsername} comentó en tu reseña de ${professorName}`,
                        },
                        { reviewId, commentId, type: "comment" },
                        reviewAuthorId,
                        notifData
                    );
                } else {
                    await saveNotification(reviewAuthorId, notifData);
                }
            }
        }

        // Notify parent comment author when someone replies to their comment
        if (parentCommentId) {
            const parentSnap = await db.collection("comments").doc(parentCommentId).get();
            if (parentSnap.exists) {
                const parentAuthorId = parentSnap.data()?.userId;
                if (
                    parentAuthorId &&
                    parentAuthorId !== commenterId &&
                    parentAuthorId !== reviewAuthorId
                ) {
                    const parentAuthorSnap = await db.collection("users").doc(parentAuthorId).get();
                    if (parentAuthorSnap.exists) {
                        const parentAuthorData = parentAuthorSnap.data();
                        const notifData = {
                            type: "reply",
                            fromUserId: commenterId,
                            fromUsername: commenterUsername,
                            reviewId,
                            commentId,
                        };
                        const fcmToken = getFcmToken(parentAuthorData);
                        if (checkPref(parentAuthorData, "comentarios") && fcmToken) {
                            await sendPushAndSave(
                                fcmToken,
                                {
                                    title: "Respondieron tu comentario",
                                    body: `${commenterUsername} respondió tu comentario`,
                                },
                                { reviewId, commentId, type: "reply" },
                                parentAuthorId,
                                notifData
                            );
                        } else {
                            await saveNotification(parentAuthorId, notifData);
                        }
                    }
                }
            }
        }
    }
);

exports.onFollowCreated = onDocumentCreated(
    "users/{userId}/followers/{followerId}",
    async (event) => {
        const userId = event.params.userId;       // recipient (followed)
        const followerId = event.params.followerId; // sender (follower)

        const [recipientSnap, followerSnap] = await Promise.all([
            db.collection("users").doc(userId).get(),
            db.collection("users").doc(followerId).get(),
        ]);

        if (!recipientSnap.exists) return;

        const recipientData = recipientSnap.data();
        const followerUsername = followerSnap.data()?.username || "Alguien";

        const notifData = {
            type: "follow",
            fromUserId: followerId,
            fromUsername: followerUsername,
            reviewId: null,
            commentId: null,
        };

        if (!checkPref(recipientData, "seguidores")) {
            await saveNotification(userId, notifData);
            return;
        }

        const fcmToken = getFcmToken(recipientData);
        if (!fcmToken) {
            await saveNotification(userId, notifData);
            return;
        }

        await sendPushAndSave(
            fcmToken,
            {
                title: "¡Tienes un nuevo seguidor!",
                body: `${followerUsername} empezó a seguirte`,
            },
            { followerId, type: "follow" },
            userId,
            notifData
        );
    }
);
