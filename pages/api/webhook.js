import Stripe from 'stripe';
import { buffer } from 'micro';
import User from '../../models/User';
import nodemailer from 'nodemailer';
import { getCampground } from '../../util/campgrounds';

export const config = {
  api: {
    bodyParser: false,
  },
};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function sendConfirmationEmail({ recipient, campground, user, trip, isOwner = false }) {
  console.log(`Attempting to send email to: ${recipient}`);
  const { checkIn, checkOut, guests, charge, days } = trip;

  // Fallback for undefined names
  const userName = user?.name || 'Customer';
  const ownerName = campground?.owner?.name || 'Campground Owner';
  const subject = isOwner
    ? `New Booking Confirmation for ${campground.name}`
    : `Your Booking Confirmation for ${campground.name}`;

  // Calculate pricing with safeguards
  const adults = parseInt(guests?.adults || 0);
  const children = parseInt(guests?.children || 0);
  const infants = parseInt(guests?.infants || 0);
  const adultPrice = parseFloat(campground?.price?.adults || 0);
  const childPrice = parseFloat(campground?.price?.children || 0);
  const tripDays = parseInt(days || 1);
  const discountPercent = parseFloat(campground?.price?.discount || 0);

  const basePrice = (adults * adultPrice + children * childPrice) * tripDays;
  const discountAmount = discountPercent > 0 ? (basePrice * discountPercent) / 100 : 0;
  const afterDiscount = basePrice - discountAmount;
  const plusDiscount = user?.premium?.subscribed ? afterDiscount * 0.2 : 0;
  const finalTotal = parseFloat(charge || afterDiscount * (user?.premium?.subscribed ? 0.8 : 1)).toFixed(2);

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; padding: 20px; background: #f9f9f9; border-radius: 8px; }
        .header { background: #4CAF50; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .header h1 { margin: 0; font-size: 24px; }
        .content { padding: 20px; background: white; border-radius: 0 0 8px 8px; }
        .details, .bill { margin-bottom: 20px; }
        .details ul { list-style: none; padding: 0; }
        .details li { margin-bottom: 10px; }
        .bill table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        .bill th, .bill td { border: 1px solid #ddd; padding: 10px; text-align: left; }
        .bill th { background: #f1f1f1; font-weight: bold; }
        .bill .total { font-weight: bold; }
        .footer { text-align: center; font-size: 12px; color: #777; margin-top: 20px; }
        .button { display: inline-block; padding: 10px 20px; background: #4CAF50; color: white !important; text-decoration: none; border-radius: 5px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>YelpCamp Booking Confirmation</h1>
        </div>
        <div class="content">
          <p>Dear ${isOwner ? ownerName : userName},</p>
          <p>${isOwner ? 'A new booking has been made for your campground.' : 'Thank you for booking with YelpCamp! Your adventure awaits!'}</p>
          <div class="details">
            <h2>Booking Details</h2>
            <ul>
              <li><strong>Campground:</strong> ${campground.name || 'N/A'}</li>
              <li><strong>Location:</strong> ${campground?.location?.city || ''}, ${campground?.location?.state || ''}, ${campground?.location?.country || ''}</li>
              <li><strong>Check-In:</strong> ${checkIn || 'N/A'}</li>
              <li><strong>Check-Out:</strong> ${checkOut || 'N/A'}</li>
              <li><strong>Guests:</strong> ${adults} Adults, ${children} Children, ${infants} Infants</li>
            </ul>
          </div>
          <div class="bill">
            <h2>Bill Details</h2>
            <table>
              <tr>
                <th>Description</th>
                <th>Amount (₹)</th>
              </tr>
              <tr>
                <td>Base Price (${adults} Adults @ ₹${adultPrice.toFixed(2)} + ${children} Children @ ₹${childPrice.toFixed(2)} × ${tripDays} Days)</td>
                <td>${basePrice.toFixed(2)}</td>
              </tr>
              ${discountPercent > 0 ? `
                <tr>
                  <td>Campground Discount (${discountPercent}%)</td>
                  <td>-${discountAmount.toFixed(2)}</td>
                </tr>
              ` : ''}
              ${user?.premium?.subscribed ? `
                <tr>
                  <td>YelpCamp Plus Discount (20%)</td>
                  <td>-${plusDiscount.toFixed(2)}</td>
                </tr>
              ` : ''}
              <tr class="total">
                <td>Total</td>
                <td>₹${finalTotal}</td>
              </tr>
            </table>
            ${isOwner ? `<p><strong>Earnings credited:</strong> ₹${(finalTotal * 0.65).toFixed(2)} (65% of total)</p>` : '<p>We look forward to your stay!</p>'}
          </div>
          ${!isOwner ? `
            <a href="#" class="button">View Your Booking</a>
          ` : ''}
        </div>
        <div class="footer">
          <p>YelpCamp Team | support@yelpcamp.com | &copy; 2025 YelpCamp</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await transporter.sendMail({
      from: `"YelpCamp" <${process.env.EMAIL_USER}>`,
      to: recipient,
      subject,
      html: htmlContent,
    });
    console.log(`Email sent successfully to: ${recipient}`);
  } catch (error) {
    console.error(`Failed to send email to ${recipient}: ${error.message}`);
    throw error;
  }
}

export default async function webhookHandler(req, res) {
  const stripe = new Stripe(process.env.STRIPE_PRIVATE_KEY);

  if (req.method === 'POST') {
    const buf = await buffer(req);
    const sign = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
      if (!sign || !webhookSecret) {
        console.error('Missing signature or webhook secret');
        return res.status(400).send('Missing signature or webhook secret');
      }

      event = stripe.webhooks.constructEvent(buf, sign, webhookSecret);
      console.log('Received event:', event.type);
    } catch (e) {
      console.error(`Webhook error: ${e.message}`);
      return res.status(400).send(`Webhook error: ${e.message}`);
    }

    if (event.type === 'customer.subscription.created') {
      const { email } = event.data.object.metadata;
      await User.findOneAndUpdate(
        { email },
        { premium: { subscribed: true } }
      );
      console.log(`Premium subscription activated for: ${email}`);
    } else if (event.type === 'checkout.session.completed') {
      const {
        user: userId,
        checkIn,
        checkOut,
        camp,
        owner,
        adults,
        children,
        infants,
        days,
      } = event.data.object.metadata;

      console.log('Processing checkout.session.completed for user:', userId, 'camp:', camp);

      const campground = await getCampground(camp, false, false);
      const user = await User.findById(userId);
      if (!user || !user.email) {
        console.error('User not found or missing email for ID:', userId);
        return res.status(400).send('User not found');
      }
      if (!campground) {
        console.error('Campground not found for ID:', camp);
        return res.status(400).send('Campground not found');
      }

      const trip = {
        checkIn,
        checkOut,
        campground: camp,
        payment_intent: event.data.object.payment_intent,
        charge: event.data.object.amount_total / 100,
        days,
        guests: { adults, children, infants },
      };

      await User.findByIdAndUpdate(userId, { $push: { trips: trip } });
      console.log(`Trip added for user: ${userId}`);

      await User.updateOne(
        { 'campgrounds.campground': camp },
        {
          $inc: {
            'campgrounds.$.earnings': (event.data.object.amount_total / 100) * 0.65,
          },
        }
      );
      console.log(`Earnings updated for campground: ${camp}`);

      const notification = {
        campground: camp,
        user: userId,
        dates: { checkIn, checkOut },
        read: false,
        guests: { adults, children, infants },
      };

      const ownerData = await User.findById(owner);
      if (!ownerData) {
        console.error(`No user found with ID: ${owner}`);
      } else {
        await User.findByIdAndUpdate(owner, {
          $push: { notifications: notification },
        });
        console.log(`Notification added for owner: ${owner}`);
      }

      try {
        console.log('Sending user email to:', user.email);
        await sendConfirmationEmail({
          recipient: user.email,
          campground: { ...campground, owner: ownerData || {} },
          user,
          trip,
        });
        console.log(`Confirmation email sent to user: ${user.email}`);
        if (ownerData && ownerData.email) {
          console.log('Sending owner email to:', ownerData.email);
          await sendConfirmationEmail({
            recipient: ownerData.email,
            campground: { ...campground, owner: ownerData || {} },
            user,
            trip,
            isOwner: true,
          });
          console.log(`Confirmation email sent to owner: ${ownerData.email}`);
        } else {
          console.error('Owner email not found for ID:', owner);
        }
      } catch (emailError) {
        console.error(`Email sending failed: ${emailError.message}`);
      }
    }

    res.status(200).send();
  }
}