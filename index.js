const express = require('express');
const cors = require('cors');
const app = express()
const port = process.env.PORT || 8000
require('dotenv').config()
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');

app.use(cors(
    /* {
        origin: [process.env.CLIENT_URL, 'https://crowdfunding.vercel.app'],
        credentials: true
    } */
))
app.use(express.json())


app.get('/', (req, res) => {
    res.send('Welcome to the Crowdfunding Platform Server!')
})

const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

client.connect(() => {
    console.log('connecting to Mongo db');
}).catch(console.dir)

// MongoDB Collections
const db = client.db("crowdfunding");
const campaignsCollection = db.collection("campaigns");
const usersCollection = db.collection("user");
const contributionsCollection = db.collection("contributions");
const paymentsCollection = db.collection("payments");
const withdrawalsCollection = db.collection("withdrawals");
const notificationsCollection = db.collection("notifications");
const reportsCollection = db.collection("reports");
const sessionCollection = db.collection("session");

// ---- Role middleware ----
const verifyCreator = (req, res, next) => {
    if (req.user?.role !== 'creator') return res.status(403).send({ message: 'forbidden' });
    next();
}

const verifySupporter = (req, res, next) => {
    if (req.user?.role !== 'supporter') return res.status(403).send({ message: 'forbidden' });
    next();
}

const verifyAdmin = (req, res, next) => {
    if (req.user?.role !== 'admin') return res.status(403).send({ message: 'forbidden' });
    next();
}

// session-based token verification middleware
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers?.authorization;
    if (!authHeader) return res.status(401).send({ message: 'unauthorized access' });

    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).send({ message: 'unauthorized access' });

    const session = await sessionCollection.findOne({ token });
    if (!session) return res.status(401).send({ message: 'unauthorized access' });

    const user = await usersCollection.findOne({ _id: session.userId });
    if (!user) return res.status(401).send({ message: 'unauthorized access' });

    req.user = user;
    next();
}

// ---- Notification helper ----
// Creates a notification doc. Matches the exact shape required by the doc:
// { message, toEmail, actionRoute, time }
const notify = async (message, toEmail, actionRoute) => {
    try {
        await notificationsCollection.insertOne({
            message,
            toEmail,
            actionRoute,
            time: new Date(),
            read: false,
        });
    } catch (err) {
        console.error('Notification insert failed:', err.message);
    }
}


/* ===========================================================
   CAMPAIGNS
   =========================================================== */

// 1. GET campaigns — search, filter (category/status/deadline), sort, pagination
app.get('/api/campaigns', async (req, res) => {
    const query = {};
    if (req.query.creatorEmail) query.creator_email = req.query.creatorEmail;
    if (req.query.status) query.status = req.query.status;
    if (req.query.category) query.category = req.query.category;
    if (req.query.search) query.campaign_title = { $regex: req.query.search, $options: 'i' };

    // "Explore Campaigns" (Supporter view): only approved + deadline not passed
    if (req.query.activeOnly === 'true') {
        query.status = 'approved';
        query.deadline = { $gte: new Date().toISOString() };
    }

    let sortObj = { createdAt: -1 };
    if (req.query.sort === 'goal_asc') sortObj = { funding_goal: 1 };
    if (req.query.sort === 'goal_desc') sortObj = { funding_goal: -1 };
    if (req.query.sort === 'deadline') sortObj = { deadline: 1 };
    if (req.query.sort === 'deadline_desc') sortObj = { deadline: -1 };

    const page = parseInt(req.query.page) || 1;
    const perPage = parseInt(req.query.perPage) || 9;
    const skip = (page - 1) * perPage;

    const total = await campaignsCollection.countDocuments(query);
    const campaigns = await campaignsCollection.find(query).sort(sortObj).skip(skip).limit(perPage).toArray();
    res.send({ total, campaigns });
});

// 2. GET top funded campaigns (Home page) — top 6 approved by amount_raised
app.get('/api/campaigns/top-funded', async (req, res) => {
    try {
        const campaigns = await campaignsCollection
            .find({ status: 'approved' })
            .sort({ amount_raised: -1 })
            .limit(6)
            .toArray();
        res.send(campaigns);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 3. GET single campaign
app.get('/api/campaigns/:id', async (req, res) => {
    const result = await campaignsCollection.findOne({ _id: new ObjectId(req.params.id) });
    res.send(result);
});

// 4. POST new campaign (creator) — saved as "pending", visible after admin approval
app.post('/api/campaigns', verifyToken, verifyCreator, async (req, res) => {
    try {
        const campaign = req.body;
        const newCampaign = {
            ...campaign,
            creator_email: req.user.email,
            creator_name: req.user.name,
            amount_raised: 0,
            status: 'pending',
            createdAt: new Date()
        };
        const result = await campaignsCollection.insertOne(newCampaign);
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 5. PATCH update campaign (creator) — per doc, only title/story/reward_info are editable
app.patch('/api/campaigns/:id', verifyToken, verifyCreator, async (req, res) => {
    try {
        const { campaign_title, campaign_story, reward_info } = req.body;
        const updates = { updatedAt: new Date() };
        if (campaign_title !== undefined) updates.campaign_title = campaign_title;
        if (campaign_story !== undefined) updates.campaign_story = campaign_story;
        if (reward_info !== undefined) updates.reward_info = reward_info;

        const result = await campaignsCollection.updateOne(
            { _id: new ObjectId(req.params.id), creator_email: req.user.email },
            { $set: updates }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 6. DELETE campaign (creator) — refunds all approved supporters' contribution credits
app.delete('/api/campaigns/:id', verifyToken, verifyCreator, async (req, res) => {
    try {
        const campaignId = req.params.id;
        const campaign = await campaignsCollection.findOne({ _id: new ObjectId(campaignId), creator_email: req.user.email });
        if (!campaign) return res.status(404).send({ message: 'Campaign not found' });

        const approvedContributions = await contributionsCollection.find({
            campaign_id: campaignId,
            status: 'approved'
        }).toArray();

        for (const c of approvedContributions) {
            await usersCollection.updateOne(
                { email: c.supporter_email },
                { $inc: { credits: c.Contribution_amount } }
            );
        }

        await contributionsCollection.deleteMany({ campaign_id: campaignId });
        const result = await campaignsCollection.deleteOne({ _id: new ObjectId(campaignId) });
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 7. PATCH campaign status (admin approve/reject)
app.patch('/api/campaigns/:id/status', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { status } = req.body; // 'approved' | 'rejected'
        const campaign = await campaignsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!campaign) return res.status(404).send({ message: 'Campaign not found' });

        const result = await campaignsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status, updatedAt: new Date() } }
        );

        await notify(
            `Your campaign "${campaign.campaign_title}" was ${status} by the admin`,
            campaign.creator_email,
            '/dashboard/creator/my-campaigns'
        );

        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 8. DELETE campaign (admin — Manage Campaigns)
app.delete('/api/admin/campaigns/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        await contributionsCollection.deleteMany({ campaign_id: req.params.id });
        const result = await campaignsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


/* ===========================================================
   CONTRIBUTIONS
   =========================================================== */

// 9. POST contribution (supporter) — deducts credits immediately, status "pending"
app.post('/api/contributions', verifyToken, verifySupporter, async (req, res) => {
    try {
        const { campaign_id, Contribution_amount, message } = req.body;

        const campaign = await campaignsCollection.findOne({ _id: new ObjectId(campaign_id) });
        if (!campaign) return res.status(404).send({ message: 'Campaign not found' });
        if (campaign.status !== 'approved') return res.status(400).send({ message: 'Campaign is not open for contributions' });
        if (Contribution_amount < campaign.minimum_Contribution) {
            return res.status(400).send({ message: `Minimum contribution is ${campaign.minimum_Contribution} credits` });
        }
        if ((req.user.credits || 0) < Contribution_amount) {
            return res.status(400).send({ message: 'Insufficient credits' });
        }

        const newContribution = {
            campaign_id,
            campaign_title: campaign.campaign_title,
            Contribution_amount,
            supporter_email: req.user.email,
            supporter_name: req.user.name,
            creator_name: campaign.creator_name,
            creator_email: campaign.creator_email,
            message: message || '',
            current_date: new Date(),
            status: 'pending',
        };

        const result = await contributionsCollection.insertOne(newContribution);

        // deduct credits from supporter immediately
        await usersCollection.updateOne(
            { email: req.user.email },
            { $inc: { credits: -Contribution_amount } }
        );

        await notify(
            `${req.user.name} contributed ${Contribution_amount} credits to ${campaign.campaign_title}`,
            campaign.creator_email,
            '/dashboard/creator'
        );

        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 10. GET contributions — filterable by supporter, creator, campaign, status
app.get('/api/contributions', verifyToken, async (req, res) => {
    try {
        const query = {};
        if (req.query.supporterEmail) query.supporter_email = req.query.supporterEmail;
        if (req.query.creatorEmail) query.creator_email = req.query.creatorEmail;
        if (req.query.campaignId) query.campaign_id = req.query.campaignId;
        if (req.query.status) query.status = req.query.status;

        const page = parseInt(req.query.page) || 1;
        const perPage = parseInt(req.query.perPage) || 10;
        const skip = (page - 1) * perPage;

        const total = await contributionsCollection.countDocuments(query);
        const contributions = await contributionsCollection.find(query).sort({ current_date: -1 }).skip(skip).limit(perPage).toArray();
        res.send({ total, contributions });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 11. PATCH contribution status (creator approve/reject)
app.patch('/api/contributions/:id', verifyToken, verifyCreator, async (req, res) => {
    try {
        const { status } = req.body; // 'approved' | 'rejected'
        const contribution = await contributionsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!contribution) return res.status(404).send({ message: 'Contribution not found' });
        if (contribution.creator_email !== req.user.email) return res.status(403).send({ message: 'forbidden' });
        if (contribution.status !== 'pending') return res.status(400).send({ message: 'Contribution already reviewed' });

        const result = await contributionsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status, updatedAt: new Date() } }
        );

        if (status === 'approved') {
            // add to campaign's raised total, and to creator's withdrawable balance
            await campaignsCollection.updateOne(
                { _id: new ObjectId(contribution.campaign_id) },
                { $inc: { amount_raised: contribution.Contribution_amount } }
            );
            await usersCollection.updateOne(
                { email: req.user.email },
                { $inc: { raised_credits: contribution.Contribution_amount } }
            );
            await notify(
                `Your contribution of ${contribution.Contribution_amount} credits to ${contribution.campaign_title} was approved by ${req.user.name}`,
                contribution.supporter_email,
                '/dashboard/supporter'
            );
        } else if (status === 'rejected') {
            // refund credits back to supporter
            await usersCollection.updateOne(
                { email: contribution.supporter_email },
                { $inc: { credits: contribution.Contribution_amount } }
            );
            await notify(
                `Your contribution of ${contribution.Contribution_amount} credits to ${contribution.campaign_title} was rejected by ${req.user.name}`,
                contribution.supporter_email,
                '/dashboard/supporter'
            );
        }

        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


/* ===========================================================
   CREDITS / PAYMENTS (Supporter buys credits via Stripe)
   =========================================================== */

// 12. POST record a completed credit purchase
app.post('/api/payments', verifyToken, verifySupporter, async (req, res) => {
    try {
        const { credits_purchased, price_paid, transactionId } = req.body;

        const payment = {
            supporter_email: req.user.email,
            supporter_name: req.user.name,
            credits_purchased,
            price_paid,
            transactionId,
            paidAt: new Date(),
            createdAt: new Date(),
        };
        const result = await paymentsCollection.insertOne(payment);

        await usersCollection.updateOne(
            { email: req.user.email },
            { $inc: { credits: credits_purchased } }
        );

        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 13. GET payment history (supporter's own credit purchases)
app.get('/api/payments', verifyToken, async (req, res) => {
    try {
        const query = {};
        if (req.query.supporterEmail) query.supporter_email = req.query.supporterEmail;
        const payments = await paymentsCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(payments);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


/* ===========================================================
   WITHDRAWALS (Creator)
   =========================================================== */

// 14. POST withdrawal request (creator) — 20 credits = $1, min 200 credits raised
app.post('/api/withdrawals', verifyToken, verifyCreator, async (req, res) => {
    try {
        const { withdrawal_credit, payment_system, account_number } = req.body;
        const available = req.user.raised_credits || 0;

        if (available < 200) {
            return res.status(400).send({ message: 'Insufficient credit. Minimum 200 credits required to withdraw.' });
        }
        if (withdrawal_credit > available) {
            return res.status(400).send({ message: 'Withdrawal exceeds available raised credits' });
        }

        const withdrawal = {
            creator_email: req.user.email,
            creator_name: req.user.name,
            withdrawal_credit,
            withdrawal_amount: withdrawal_credit / 20,
            payment_system,
            account_number,
            withdraw_date: new Date(),
            status: 'pending',
        };
        const result = await withdrawalsCollection.insertOne(withdrawal);
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 15. GET withdrawals — creator sees own, admin sees all (optionally filtered by status)
app.get('/api/withdrawals', verifyToken, async (req, res) => {
    try {
        const query = {};
        if (req.user.role === 'creator') query.creator_email = req.user.email;
        if (req.query.status) query.status = req.query.status;

        const withdrawals = await withdrawalsCollection.find(query).sort({ withdraw_date: -1 }).toArray();
        res.send(withdrawals);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 16. PATCH withdrawal → approve (admin "Payment Success" button)
app.patch('/api/withdrawals/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!withdrawal) return res.status(404).send({ message: 'Withdrawal not found' });
        if (withdrawal.status !== 'pending') return res.status(400).send({ message: 'Already processed' });

        const result = await withdrawalsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { status: 'approved', approvedAt: new Date() } }
        );

        await usersCollection.updateOne(
            { email: withdrawal.creator_email },
            { $inc: { raised_credits: -withdrawal.withdrawal_credit } }
        );

        await notify(
            `Your withdrawal request of ${withdrawal.withdrawal_credit} credits ($${withdrawal.withdrawal_amount}) was approved`,
            withdrawal.creator_email,
            '/dashboard/creator/payment-history'
        );

        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


/* ===========================================================
   NOTIFICATIONS
   =========================================================== */

// 17. GET notifications for logged-in user, sorted desc
app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        const notifications = await notificationsCollection
            .find({ toEmail: req.user.email })
            .sort({ time: -1 })
            .toArray();
        res.send(notifications);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 17b. PATCH mark a single notification as read
app.patch('/api/notifications/:id/read', verifyToken, async (req, res) => {
    try {
        const result = await notificationsCollection.updateOne(
            { _id: new ObjectId(req.params.id), toEmail: req.user.email },
            { $set: { read: true } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 17c. PATCH mark all of the logged-in user's notifications as read
app.patch('/api/notifications/read-all', verifyToken, async (req, res) => {
    try {
        const result = await notificationsCollection.updateMany(
            { toEmail: req.user.email, read: false },
            { $set: { read: true } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


/* ===========================================================
   REPORTS (Supporter reports a suspicious/fraudulent campaign)
   =========================================================== */

// 18. POST report (supporter)
app.post('/api/reports', verifyToken, verifySupporter, async (req, res) => {
    try {
        const { campaign_id, campaign_title, reason } = req.body;
        const report = {
            campaign_id,
            campaign_title,
            reporter_name: req.user.name,
            reporter_email: req.user.email,
            reason,
            date: new Date(),
            status: 'open',
        };
        const result = await reportsCollection.insertOne(report);
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 19. GET reports (admin)
app.get('/api/reports', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const reports = await reportsCollection.find({}).sort({ date: -1 }).toArray();
        res.send(reports);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 20. PATCH report — admin suspends or deletes the reported campaign
app.patch('/api/reports/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { action } = req.body; // 'suspend' | 'delete'
        const report = await reportsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!report) return res.status(404).send({ message: 'Report not found' });

        if (action === 'suspend') {
            await campaignsCollection.updateOne(
                { _id: new ObjectId(report.campaign_id) },
                { $set: { status: 'rejected' } }
            );
            await reportsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'suspended' } });
        } else if (action === 'delete') {
            await contributionsCollection.deleteMany({ campaign_id: report.campaign_id });
            await campaignsCollection.deleteOne({ _id: new ObjectId(report.campaign_id) });
            await reportsCollection.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'resolved' } });
        }

        res.send({ success: true });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


/* ===========================================================
   USERS (Admin — Manage Users)
   =========================================================== */

// 21. GET all users (admin) — search + role filter
app.get('/api/users', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const query = {};
        if (req.query.role) query.role = req.query.role;
        if (req.query.search) {
            query.$or = [
                { name: { $regex: req.query.search, $options: 'i' } },
                { email: { $regex: req.query.search, $options: 'i' } }
            ];
        }

        const users = await usersCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(users);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 22. PATCH update user role (admin)
app.patch('/api/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { role } = req.body;
        const result = await usersCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { role, updatedAt: new Date() } }
        );
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 23. DELETE user (admin — Remove button)
app.delete('/api/users/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 24. GET current user info
app.get('/api/users/me', verifyToken, async (req, res) => {
    try {
        res.send(req.user);
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


/* ===========================================================
   DASHBOARD STATS
   =========================================================== */

// 25. Supporter stats
app.get('/api/supporter/stats', verifyToken, verifySupporter, async (req, res) => {
    try {
        const email = req.user.email;
        const [totalContributions, totalPending, approvedContribs] = await Promise.all([
            contributionsCollection.countDocuments({ supporter_email: email }),
            contributionsCollection.countDocuments({ supporter_email: email, status: 'pending' }),
            contributionsCollection.find({ supporter_email: email, status: 'approved' }).toArray(),
        ]);
        const totalAmountContributed = approvedContribs.reduce((sum, c) => sum + (c.Contribution_amount || 0), 0);

        res.send({ totalContributions, totalPending, totalAmountContributed, credits: req.user.credits || 0 });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 26. Creator stats
app.get('/api/creator/stats', verifyToken, verifyCreator, async (req, res) => {
    try {
        const email = req.user.email;
        const campaigns = await campaignsCollection.find({ creator_email: email }).toArray();
        const totalCampaigns = campaigns.length;
        const activeCampaigns = campaigns.filter(c => new Date(c.deadline) >= new Date()).length;
        const totalRaised = campaigns.reduce((sum, c) => sum + (c.amount_raised || 0), 0);

        res.send({
            totalCampaigns,
            activeCampaigns,
            totalRaised,
            raisedCredits: req.user.raised_credits || 0,
            withdrawableDollars: (req.user.raised_credits || 0) / 20,
        });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});

// 27. Admin stats
app.get('/api/admin/stats', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const [totalSupporters, totalCreators, users, totalPayments] = await Promise.all([
            usersCollection.countDocuments({ role: 'supporter' }),
            usersCollection.countDocuments({ role: 'creator' }),
            usersCollection.find({}).toArray(),
            paymentsCollection.countDocuments(),
        ]);
        const totalAvailableCredits = users.reduce((sum, u) => sum + (u.credits || 0), 0);

        res.send({
            totalSupporters,
            totalCreators,
            totalAvailableCredits,
            totalPayments,
        });
    } catch (err) {
        res.status(500).send({ message: err.message });
    }
});


console.log("Pinged your deployment. You successfully connected to MongoDB!");

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

module.exports = app;
