const {
    onDocumentUpdated,
    onDocumentCreated,
    onDocumentDeleted,
} = require('firebase-functions/v2/firestore');

const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

admin.initializeApp()
const db = admin.firestore()
const FieldValue = admin.firestore.FieldValue

exports.updateUserInfoInReviews = onDocumentUpdated(
    "users/{userId}",
    async (event) => {
        const userId = event.params.userId;

        const beforeData = event.data.before.data();
        const afterData = event.data.after.data();

        if(beforeData.username === afterData.username) {
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
            batch.update(doc.ref, {
                "user.username": afterData.username
            })
        })

        await batch.commit();
        logger.log("Reviews actualizadas para el usuario:", userId);
    }
);

exports.onLikeCreated = onDocumentCreated(
    "reviews/{reviewId}/likes/{likeId}",
    async (event) => {
        const reviewId = event.params.reviewId;
        const likerId = event.params.likeId;
        const reviewRef = db.collection("reviews").doc(reviewId);

        const [reviewSnap] = await Promise.all([
            reviewRef.get(),
            reviewRef.update({ likesCount: FieldValue.increment(1) }),
        ]);

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

        const fcmToken = authorSnap.data()?.fcmtoken;
        if (!fcmToken) return;

        const likerUsername = likerSnap.data()?.username || "Alguien";
        const professorName = review.professor?.name || "un profesor";

        try {
            await admin.messaging().send({
                token: fcmToken,
                notification: {
                    title: "¡Le dieron like a tu reseña!",
                    body: `${likerUsername} le dio like a tu reseña de ${professorName}`,
                },
                data: { reviewId, type: "like" },
            });
            logger.log("Notificación enviada a:", authorId);
        } catch (error) {
            logger.error("Error al enviar notificación:", error);
        }
    }
);

exports.onLikeRemoved = onDocumentDeleted(
    "reviews/{reviewId}/likes/{likeId}",
    async (event) => {
        const reviewId = event.params.reviewId;
        await db.collection("reviews").doc(reviewId).update({
            likesCount: FieldValue.increment(-1),
        });
        logger.log("likesCount decrementado en review:", reviewId);
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