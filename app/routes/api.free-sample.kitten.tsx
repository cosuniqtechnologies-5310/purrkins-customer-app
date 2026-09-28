import type { LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const petIndex = parseInt(url.searchParams.get("pet_index") || "0", 10);

  const liquidTemplate = `
    {% if customer == blank %}
      <script>window.location.href = "/account/login?checkout_url=/apps/purrkins/kitten";</script>
    {% endif %}

    {% assign pets = customer.metafields.custom.pets.value %}
    {% assign pet_count = pets.count | default: 0 %}
    {% assign active_index = ${petIndex} %}
    {% assign current_pet = blank %}
    
    {% for pet in pets %}
      {% if forloop.index0 == active_index %}
        {% assign current_pet = pet %}
      {% endif %}
    {% endfor %}

    <div class="pk-dashboard-wrapper">
      
      <!-- PET SELECTOR HEADER -->
      <div class="pk-pet-selector-row">
        {% for pet in pets %}
          <a href="?pet_index={{ forloop.index0 }}" class="pk-pet-pill {% if forloop.index0 == active_index %}active{% endif %}">
            <div class="pk-pet-avatar" {% if forloop.index0 != active_index %}style="background:#e0e0e0;"{% endif %}>
              {% if pet.profile.value %}
                <img src="{{ pet.profile.value | image_url: width: 100 }}" {% if forloop.index0 != active_index %}style="opacity:0.6"{% endif %} alt="{{ pet.name.value }}">
              {% else %}
                <svg width="100%" height="100%" viewBox="0 0 24 24" fill="#d1d1d1" xmlns="http://www.w3.org/2000/svg" {% if forloop.index0 != active_index %}style="opacity:0.6"{% endif %}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
              {% endif %}
            </div>
            <div class="pk-pet-info">
              <strong>{{ pet.name.value | default: 'Kitten' }}</strong>
              <span>{{ pet.age.value | default: 'Unknown' }}</span>
            </div>
          </a>
        {% endfor %}
        <a href="/pages/byob" class="pk-pet-add-btn">+ Add Kitten</a>
      </div>

      <div class="pk-dashboard-layout">
        <!-- SIDEBAR -->
        <div class="pk-dashboard-sidebar">
          <div class="pk-sidebar-menu">
            <a href="/apps/purrkins/dashboard" class="pk-menu-item"><span class="pk-dot"></span> Overview</a>
            <a href="/apps/purrkins/kitten" class="pk-menu-item active"><span class="pk-dot"></span> Kitten's Profile</a>
            <a href="#quiz" class="pk-menu-item"><span class="pk-dot"></span> Your Quiz Answers</a>
            <a href="#subscription" class="pk-menu-item"><span class="pk-dot"></span> Subscriptions <span class="pk-badge">1</span></a>
            <a href="#vet" class="pk-menu-item"><span class="pk-dot"></span> Talk to a Vet</a>
          </div>

          <div class="pk-whatsapp-card">
            <h3>Stuck on something?</h3>
            <p>Our kitten team replies on WhatsApp, usually within an hour.</p>
            <a href="#" class="pk-whatsapp-btn">Reach Out <span class="wa-icon">💬</span></a>
          </div>
        </div>

        <!-- MAIN CONTENT -->
        <div class="pk-dashboard-content">
          {% if current_pet != blank %}
            
            <!-- PROFILE CARD -->
            <div class="pk-card pk-profile-card">
              <div class="pk-card-header">
                <h2>{{ current_pet.name.value | default: 'Kitten' }}'s profile</h2>
                <button class="pk-outline-btn" id="edit-details-btn" style="border-radius:30px; cursor:pointer; background:none;">Edit Details</button>
              </div>
              
              <div class="pk-profile-details" id="profile-view-mode">
                <div class="pk-profile-photo">
                  <!-- DEBUG: profile={{ current_pet.profile }} id={{ current_pet.profile.value.id }} -->
                  {% if current_pet.profile.value %}
                    <img src="{{ current_pet.profile.value | image_url: width: 300 }}" alt="{{ current_pet.name.value }}">
                  {% else %}
                    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="#d1d1d1" xmlns="http://www.w3.org/2000/svg" style="background:#f4f4f5; padding:10px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
                  {% endif %}
                </div>
                <div class="pk-profile-stats">
                  <div class="pk-stat-box">
                    <label>Age</label>
                    <span>{{ current_pet.age.value | default: '-' }}</span>
                  </div>
                  <div class="pk-stat-box">
                    <label>Weight</label>
                    <span>{{ current_pet.weight.value | default: '-' }}</span>
                  </div>
                  <div class="pk-stat-box">
                    <label>Body Type</label>
                    <span>{{ current_pet.body.value | default: 'Normal' }}</span>
                  </div>
                  <div class="pk-stat-box">
                    <label>Sex</label>
                    <span>{{ current_pet.gender.value | default: '-' }}, {{ current_pet.neutered.value | default: '-' }}</span>
                  </div>
                  <div class="pk-stat-box">
                    <label>Activity Level</label>
                    <span>{{ current_pet.activity.value | default: 'Playful, indoor only' }}</span>
                  </div>
                  <div class="pk-stat-box">
                    <label>Birthday</label>
                    <span>-</span>
                  </div>
                  <div class="pk-stat-box">
                    <label>Focus Area</label>
                    <span>{{ current_pet.focus.value | default: 'None' }}</span>
                  </div>
                  <div class="pk-stat-box">
                    <label>Allergies</label>
                    <span>{{ current_pet.allergies.value | default: 'None recorded' }}</span>
                  </div>
                </div>
              </div>

              <!-- EDIT MODE FORM (Hidden by default) -->
              <form class="pk-profile-edit-form" id="profile-edit-mode" action="/apps/purrkins/update-pet" method="POST" style="display:none;">
                <input type="hidden" name="pet_id" value="{{ current_pet.system.id }}">
                <input type="hidden" name="customer_id" value="{{ customer.id }}">
                <input type="hidden" name="profile_image_url" id="profile-image-url-input">
                
                <div class="pk-edit-img-row">
                  <div class="pk-profile-photo" style="width: 100px; height: 100px;">
                    {% if current_pet.profile.value %}
                      <img src="{{ current_pet.profile.value | image_url: width: 200 }}" alt="{{ current_pet.name.value }}">
                    {% else %}
                      <svg width="100%" height="100%" viewBox="0 0 24 24" fill="#d1d1d1" xmlns="http://www.w3.org/2000/svg" style="background:#f4f4f5; padding:10px;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
                    {% endif %}
                  </div>
                  <div class="pk-file-upload">
                    <label>Change Profile Image</label>
                    <input type="file" id="profile-image-file" accept="image/*">
                  </div>
                </div>

                <div class="pk-edit-grid">
                  <div class="pk-input-group">
                    <label>Name</label>
                    <input type="text" name="name" value="{{ current_pet.name.value }}">
                  </div>
                  <div class="pk-input-group">
                    <label>Age</label>
                    <input type="text" name="age" value="{{ current_pet.age.value }}">
                  </div>
                  <div class="pk-input-group">
                    <label>Weight</label>
                    <input type="text" name="weight" value="{{ current_pet.weight.value }}">
                  </div>
                  <div class="pk-input-group">
                    <label>Sex</label>
                    <select name="gender">
                      <option value="Male" {% if current_pet.gender.value == 'Male' %}selected{% endif %}>Male</option>
                      <option value="Female" {% if current_pet.gender.value == 'Female' %}selected{% endif %}>Female</option>
                    </select>
                  </div>
                  <div class="pk-input-group">
                    <label>Neutered</label>
                    <select name="neutered">
                      <option value="Neutered" {% if current_pet.neutered.value == 'Neutered' %}selected{% endif %}>Neutered</option>
                      <option value="Not Neutered" {% if current_pet.neutered.value == 'Not Neutered' %}selected{% endif %}>Not Neutered</option>
                    </select>
                  </div>
                  <div class="pk-input-group">
                    <label>Body Type</label>
                    <input type="text" name="body" value="{{ current_pet.body.value }}">
                  </div>
                  <div class="pk-input-group">
                    <label>Activity Level</label>
                    <input type="text" name="activity" value="{{ current_pet.activity.value }}">
                  </div>
                  <div class="pk-input-group">
                    <label>Focus Area</label>
                    <input type="text" name="focus" value="{{ current_pet.focus.value }}">
                  </div>
                  <div class="pk-input-group" style="grid-column: 1/-1;">
                    <label>Allergies</label>
                    <input type="text" name="allergies" value="{{ current_pet.allergies.value }}">
                  </div>
                </div>

                <div style="display: flex; gap: 10px; margin-top: 20px; align-items: center;">
                  <button type="button" class="pk-outline-btn" id="cancel-edit-btn">Cancel</button>
                  <button type="submit" class="pk-dark-btn" id="save-changes-btn">Save Changes</button>
                  <span id="save-loading-text" style="display:none; font-size: 13px; color: #555;">Uploading image, please wait...</span>
                </div>
              </form>

              <div class="pk-weight-banner" id="weight-banner-ui">
                <div>
                  <strong>{{ current_pet.weight.value | default: '0 kg' }} logged recently</strong>
                  <p>Portions and pack quantities update automatically when you log a new weight.</p>
                </div>
                <button class="pk-dark-btn">Log New Weight</button>
              </div>
            </div>

            <!-- YOUR QUIZ ANSWERS CARD -->
            <div class="pk-card" id="quiz">
              <div class="pk-card-header">
                <div>
                  <h2>Your quiz answers</h2>
                  <p style="color:#8c8c9a; font-size:13px; margin-top:5px;">Everything below is built from these answers.</p>
                </div>
                <a href="/pages/byob" class="pk-outline-btn" style="border-radius:30px;">Retake Quiz</a>
              </div>

              <div class="pk-quiz-tags">
                {% if current_pet.age.value != blank %}<span class="pk-tag-pill">{{ current_pet.age.value }}</span>{% endif %}
                {% if current_pet.weight.value != blank %}<span class="pk-tag-pill">{{ current_pet.weight.value }}</span>{% endif %}
                {% if current_pet.gender.value != blank %}<span class="pk-tag-pill">{{ current_pet.gender.value }}</span>{% endif %}
                {% if current_pet.neutered.value != blank %}<span class="pk-tag-pill">{{ current_pet.neutered.value }}</span>{% endif %}
                {% if current_pet.health_flags.value != blank %}<span class="pk-tag-pill">{{ current_pet.health_flags.value }}</span>{% endif %}
              </div>

              <h3 class="pk-sub-title">Recommend for {{ current_pet.name.value | default: 'Kitten' }}</h3>
              
              <!-- Fetch recommendations from a generic collection or metafield -->
              <div class="pk-recommend-grid">
                {% assign recs = collections['all'].products %}
                {% for prod in recs limit: 3 %}
                  {% assign bg_color = '#EAF4FE' %}
                  {% if forloop.index == 2 %}{% assign bg_color = '#FEF3EB' %}{% endif %}
                  {% if forloop.index == 3 %}{% assign bg_color = '#EAF7EC' %}{% endif %}
                  
                  <div class="pk-rec-box" style="background: {{ bg_color }};">
                    <div class="pk-rec-img">
                      <img src="{{ prod.featured_image | image_url: width: 100 }}" alt="{{ prod.title }}">
                    </div>
                    <h4>{{ prod.title }}</h4>
                    <p>{{ prod.metafields.custom.short_description | default: 'Nutrition tailored to keep them healthy and active.' }}</p>
                    <a href="{{ prod.url }}" class="pk-dark-btn" style="text-align:center; text-decoration:none; display:block; {% if forloop.index == 3 %}background:#121217;{% endif %}">In Your Box</a>
                  </div>
                {% else %}
                  <p>No products found in the store.</p>
                {% endfor %}
              </div>
            </div>

            <!-- SUBSCRIPTION MONTHLY PLAN -->
            <div class="pk-card pk-sub-card" id="subscription">
              <div class="pk-card-header" style="justify-content: flex-start; gap: 15px;">
                <h2>{{ current_pet.name.value | default: 'Kitten' }}'s monthly plan</h2>
                <span class="pk-active-badge">Active</span>
              </div>

              <div class="pk-sub-stats-banner">
                <div><label>STARTED</label><span>Recently</span></div>
                <div><label>FREQUENCY</label><span>Every 30 days</span></div>
                <div><label>NEXT CHARGE</label><span>Upcoming</span></div>
                <div><label>DELIVERIES SO FAR</label><span>2</span></div>
                <div><label>YOU SAVE</label><span>15% vs one-time</span></div>
              </div>

              <div class="pk-sub-items">
                <!-- Fetch active subscription data (placeholder logic here using recent orders as example) -->
                {% for order in customer.orders limit: 1 %}
                  {% for item in order.line_items limit: 3 %}
                    <div class="pk-sub-item-row {% if forloop.last %}no-border{% endif %}">
                      <div class="pk-sub-img"><img src="{{ item.image | image_url: width: 100 }}" alt="{{ item.title }}"></div>
                      <div class="pk-sub-info">
                        <h4>{{ item.product.title }}</h4>
                        <p>{{ item.variant.title | default: '70g pouch' }}</p>
                      </div>
                      <div class="pk-sub-actions">
                        <a href="#">Swap flavour</a>
                        <div class="pk-qty-box">- {{ item.quantity }} +</div>
                        <div class="pk-sub-price">{{ item.final_price | money }}</div>
                      </div>
                    </div>
                  {% endfor %}
                {% else %}
                  <p style="padding:20px; color:#595961; margin:0;">No active subscriptions found.</p>
                {% endfor %}
              </div>

              <div class="pk-sub-add-bar">
                <span>+ Add a product to this box — treats, broths and supplement measures</span>
                <a href="/collections/all">Browse</a>
              </div>

              <div class="pk-sub-action-btns">
                <button class="pk-outline-btn" style="border-radius:30px;">Change Frequency</button>
                <button class="pk-outline-btn" style="border-radius:30px;">Change Delivery Date</button>
                <button class="pk-outline-btn" style="border-radius:30px;">Skip Next Delivery</button>
                <button class="pk-outline-btn" style="border-radius:30px;">Pause Plan</button>
                <a href="#" class="pk-cancel-link">Cancel Subscription</a>
              </div>

              <div class="pk-sub-benefits-banner">
                <div class="pk-benefit">
                  <strong>Vet on call</strong>
                  <p>Unlimited chats with the Purrkins panel</p>
                </div>
                <div class="pk-benefit">
                  <strong>12% off every order</strong>
                  <p>Applied automatically on renewal</p>
                </div>
                <div class="pk-benefit">
                  <strong>Free delivery</strong>
                  <p>On every subscription box</p>
                </div>
                <div class="pk-benefit">
                  <strong>Insurance benefit</strong>
                  <p>Partner cover</p>
                </div>
              </div>
            </div>

          {% else %}
            <!-- EMPTY STATE IF NO PETS -->
            <div class="pk-card" style="text-align:center; padding: 60px 20px;">
              <h2 style="font-family: var(--purrkins-heading-font); margin-bottom: 20px; font-size:28px;">No Kittens Found!</h2>
              <p style="color:#595961; margin-bottom:30px; font-size:16px;">Take the quiz to create a profile for your kitten and get personalized recommendations.</p>
              <a href="/pages/byob" class="pk-dark-btn" style="text-decoration:none; display:inline-block; padding:15px 30px;">Take the Quiz</a>
            </div>
          {% endif %}

          <!-- VET CARD -->
          <div class="pk-vet-card" id="vet">
            <div>
              <h3>Something not right with your kitten?</h3>
              <p>Vet chat is included with your plan. Most questions get an answer in an hour.</p>
            </div>
            <button class="pk-yellow-btn">Talk to a Vet</button>
          </div>

          <script>
            window.initPurrkinsKitten = function() {
              var editBtn = document.getElementById("edit-details-btn");
              var cancelBtn = document.getElementById("cancel-edit-btn");
              var viewMode = document.getElementById("profile-view-mode");
              var editMode = document.getElementById("profile-edit-mode");
              var weightBanner = document.getElementById("weight-banner-ui");
              var fileInput = document.getElementById("profile-image-file");
              var urlInput = document.getElementById("profile-image-url-input");
              var saveBtn = document.getElementById("save-changes-btn");
              var loadingText = document.getElementById("save-loading-text");

              if (editMode) {
                editMode.addEventListener("submit", async function(e) {
                  e.preventDefault();
                  saveBtn.disabled = true;
                  loadingText.style.display = "inline";

                  var file = fileInput.files[0];
                  try {
                    if (file) {
                      // 1. Get Upload URL
                      var urlFormData = new FormData();
                      urlFormData.append("filename", file.name);
                      urlFormData.append("mimeType", file.type);
                      
                      var res = await fetch("/apps/purrkins/get-upload-url", {
                        method: "POST",
                        body: urlFormData
                      });
                      var data = await res.json();
                      
                      if (data.success && data.target) {
                        // 2. Upload file directly to Cloud Bucket
                        var uploadForm = new FormData();
                        data.target.parameters.forEach(function(param) {
                          uploadForm.append(param.name, param.value);
                        });
                        uploadForm.append("file", file);

                        var uploadRes = await fetch(data.target.url, {
                          method: "POST",
                          body: uploadForm
                        });

                        if (uploadRes.ok) {
                          // 3. Save the resourceUrl
                          urlInput.value = data.target.resourceUrl;
                        } else {
                          alert("Image upload failed. Please try again.");
                          saveBtn.disabled = false;
                          loadingText.style.display = "none";
                          return; // Stop execution
                        }
                      } else {
                         alert("Could not initialize upload.");
                         saveBtn.disabled = false;
                         loadingText.style.display = "none";
                         return; // Stop execution
                      }
                    }

                    // Submit the final form data to update-pet via AJAX
                    var finalFormData = new FormData(editMode);
                    var finalRes = await fetch("/apps/purrkins/update-pet", {
                      method: "POST",
                      body: finalFormData
                    });
                    var finalData = await finalRes.json();

                    if (finalData.success) {
                      // Instantly update the DOM to avoid Shopify Liquid caching
                      if (file) {
                        var reader = new FileReader();
                        reader.onload = function(event) {
                          var profilePhotos = document.querySelectorAll(".pk-profile-photo img, .pk-profile-photo svg");
                          profilePhotos.forEach(function(el) {
                             if (el.tagName.toLowerCase() === 'svg') {
                                var newImg = document.createElement('img');
                                newImg.src = event.target.result;
                                newImg.alt = "Profile";
                                newImg.style.width = "100%";
                                newImg.style.height = "100%";
                                newImg.style.objectFit = "cover";
                                el.parentNode.replaceChild(newImg, el);
                             } else {
                                el.src = event.target.result;
                             }
                          });
                          // Also update active sidebar card image
                          var activeSidebarImg = document.querySelector(".pk-pet-card.active img, .pk-pet-card.active svg");
                          if (activeSidebarImg) {
                             if (activeSidebarImg.tagName.toLowerCase() === 'svg') {
                                var sImg = document.createElement('img');
                                sImg.src = event.target.result;
                                sImg.alt = "Profile";
                                sImg.style.width = "40px";
                                sImg.style.height = "40px";
                                sImg.style.borderRadius = "50%";
                                sImg.style.objectFit = "cover";
                                activeSidebarImg.parentNode.replaceChild(sImg, activeSidebarImg);
                             } else {
                                activeSidebarImg.src = event.target.result;
                             }
                          }
                        };
                        reader.readAsDataURL(file);
                      }

                      // Update text fields in view mode
                      var updateStat = function(labelName, newValue) {
                         var boxes = document.querySelectorAll('.pk-stat-box');
                         boxes.forEach(function(box) {
                            var label = box.querySelector('label');
                            if(label && label.innerText.trim() === labelName) {
                               var span = box.querySelector('span');
                               if(span) span.innerText = newValue || '-';
                            }
                         });
                      };
                      
                      updateStat('Age', finalFormData.get('age'));
                      updateStat('Weight', finalFormData.get('weight'));
                      updateStat('Body Type', finalFormData.get('body'));
                      updateStat('Sex', finalFormData.get('gender') + ', ' + finalFormData.get('neutered'));
                      updateStat('Activity Level', finalFormData.get('activity'));
                      updateStat('Focus Area', finalFormData.get('focus'));
                      updateStat('Allergies', finalFormData.get('allergies'));
                      
                      var h2 = document.querySelector('.pk-profile-header h2');
                      if (h2) h2.innerText = (finalFormData.get('name') || 'Kitten') + "'s profile";
                      var sidebarName = document.querySelector('.pk-pet-card.active strong');
                      if (sidebarName) sidebarName.innerText = finalFormData.get('name') || 'Kitten';

                      // Switch back to view mode
                      editMode.style.display = "none";
                      viewMode.style.display = "flex";
                      if (weightBanner) weightBanner.style.display = "flex";
                      if (editBtn) editBtn.style.display = "inline-block";
                      
                      // Reset buttons
                      saveBtn.disabled = false;
                      loadingText.style.display = "none";

                      // Create a toast notification
                      var toast = document.createElement("div");
                      toast.innerText = "Profile updated successfully!";
                      toast.style.position = "fixed";
                      toast.style.bottom = "20px";
                      toast.style.right = "20px";
                      toast.style.backgroundColor = "#000";
                      toast.style.color = "#fff";
                      toast.style.padding = "12px 24px";
                      toast.style.borderRadius = "8px";
                      toast.style.fontFamily = "inherit";
                      toast.style.zIndex = "9999";
                      toast.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
                      document.body.appendChild(toast);

                      setTimeout(function() {
                        toast.style.opacity = '0';
                        toast.style.transition = 'opacity 0.5s ease';
                        setTimeout(function() { toast.remove(); }, 500);
                      }, 2000);
                    } else {
                      alert("Failed to update: " + (finalData.message || "Unknown error"));
                      saveBtn.disabled = false;
                      loadingText.style.display = "none";
                    }

                  } catch (err) {
                    console.error(err);
                    alert("An error occurred during update.");
                    saveBtn.disabled = false;
                    loadingText.style.display = "none";
                  }
                });
              }

              if (editBtn) {
                editBtn.addEventListener("click", function(e) {
                  e.preventDefault();
                  viewMode.style.display = "none";
                  weightBanner.style.display = "none";
                  editMode.style.display = "block";
                  editBtn.style.display = "none";
                });
              }

              if (cancelBtn) {
                cancelBtn.addEventListener("click", function(e) {
                  e.preventDefault();
                  editMode.style.display = "none";
                  viewMode.style.display = "flex";
                  weightBanner.style.display = "flex";
                  editBtn.style.display = "block";
                });
              }
            };
            
            // Initialize immediately if script runs
            if (document.readyState === "loading") {
              document.addEventListener("DOMContentLoaded", window.initPurrkinsKitten);
            } else {
              window.initPurrkinsKitten();
            }
          </script>

        </div>
      </div>
    </div>

    <style>
      .pk-dashboard-wrapper {
        max-width: 1200px;
        margin: 40px auto;
        padding: 0 20px;
        font-family: var(--font-body--family, sans-serif);
        color: #121217;
      }
      
      /* PET SELECTOR */
      .pk-pet-selector-row {
        display: flex;
        gap: 15px;
        margin-bottom: 40px;
        align-items: center;
        flex-wrap: wrap;
      }
      .pk-pet-pill {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 24px 8px 8px;
        border-radius: 40px;
        background: #fff;
        border: 1px solid #eaeaea;
        text-decoration: none;
        color: #121217;
        transition: 0.2s;
      }
      .pk-pet-pill.active {
        background: #ffd831;
        border-color: #ffd831;
      }
      .pk-pet-avatar {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        overflow: hidden;
        background: #fff;
      }
      .pk-pet-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .pk-pet-info { display: flex; flex-direction: column; }
      .pk-pet-info strong { font-size: 15px; font-weight: 800; }
      .pk-pet-info span { font-size: 11px; color: #595961; }
      .pk-pet-add-btn {
        padding: 14px 24px;
        border-radius: 30px;
        background: #fff;
        border: 1px solid #eaeaea;
        color: #121217;
        text-decoration: none;
        font-weight: 700;
        font-size: 14px;
      }

      .pk-dashboard-layout {
        display: grid;
        grid-template-columns: 280px 1fr;
        gap: 40px;
      }
      .pk-dashboard-sidebar {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .pk-sidebar-menu {
        background: #fff;
        border: 1px solid #eaeaea;
        border-radius: 16px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .pk-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        text-decoration: none;
        color: #595961;
        font-weight: 700;
        padding: 12px;
        border-radius: 8px;
        transition: 0.2s;
        font-size: 14px;
      }
      .pk-menu-item.active {
        background: #FFF9E6;
        color: #121217;
      }
      .pk-dot {
        width: 8px;
        height: 8px;
        background: #d1d1d1;
        border-radius: 50%;
      }
      .pk-menu-item.active .pk-dot {
        background: #121217;
      }
      .pk-badge {
        background: #ffd831;
        color: #121217;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 10px;
        margin-left: auto;
      }
      .pk-whatsapp-card {
        background: #21252A;
        color: #fff;
        border-radius: 16px;
        padding: 24px;
      }
      .pk-whatsapp-card h3 {
        font-size: 18px;
        margin: 0 0 10px 0;
        color: #fff;
      }
      .pk-whatsapp-card p {
        font-size: 14px;
        color: #d1d1d1;
        margin: 0 0 20px 0;
        line-height: 1.5;
      }
      .pk-whatsapp-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: #25D366;
        color: #fff;
        text-decoration: none;
        padding: 10px 20px;
        border-radius: 30px;
        font-weight: 700;
        font-size: 15px;
      }
      
      .pk-dashboard-content {
        display: flex;
        flex-direction: column;
        gap: 30px;
      }
      .pk-card {
        background: #fff;
        border: 1px solid #eaeaea;
        border-radius: 16px;
        padding: 30px;
      }
      .pk-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;
      }
      .pk-card-header h2 {
        font-family: var(--font-heading--family, sans-serif);
        font-size: 26px;
        font-weight: 800;
        margin: 0;
      }

      /* MILO'S PROFILE */
      .pk-profile-details {
        display: flex;
        gap: 40px;
        margin-bottom: 30px;
      }
      .pk-profile-edit-form {
        margin-bottom: 30px;
      }
      .pk-edit-img-row {
        display: flex;
        align-items: center;
        gap: 20px;
        margin-bottom: 25px;
      }
      .pk-file-upload label {
        display: block;
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 5px;
      }
      .pk-file-upload input {
        font-size: 13px;
      }
      .pk-edit-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
      }
      .pk-edit-grid .pk-input-group label {
        display: block;
        font-size: 11px;
        color: #8c8c9a;
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .pk-edit-grid .pk-input-group input, .pk-edit-grid .pk-input-group select {
        width: 100%;
        border: 1px solid #eaeaea;
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 14px;
        color: #121217;
        font-family: var(--font-body--family, sans-serif);
      }
      .pk-profile-photo {
        width: 140px;
        height: 140px;
        border-radius: 16px;
        overflow: hidden;
        flex-shrink: 0;
      }
      .pk-profile-photo img { width: 100%; height: 100%; object-fit: cover; }
      .pk-profile-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
        flex-grow: 1;
      }
      .pk-stat-box label {
        display: block;
        font-size: 11px;
        color: #8c8c9a;
        margin-bottom: 4px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .pk-stat-box span {
        font-size: 14px;
        font-weight: 700;
        color: #121217;
      }
      .pk-weight-banner {
        background: #ffd831;
        border-radius: 12px;
        padding: 20px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .pk-weight-banner strong { font-size: 16px; font-weight: 800; display:block; margin-bottom: 4px;}
      .pk-weight-banner p { margin: 0; font-size: 13px; color: #121217; }
      .pk-dark-btn {
        background: #21252A;
        color: #fff;
        padding: 10px 24px;
        border-radius: 30px;
        border: none;
        font-weight: 700;
        cursor: pointer;
      }

      /* QUIZ ANSWERS */
      .pk-quiz-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 30px;
      }
      .pk-tag-pill {
        background: #f4f4f5;
        padding: 8px 16px;
        border-radius: 30px;
        font-size: 13px;
        font-weight: 600;
        color: #121217;
      }
      .pk-sub-title {
        font-family: var(--font-heading--family, sans-serif);
        font-size: 20px;
        font-weight: 800;
        margin: 0 0 20px 0;
      }
      .pk-recommend-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
      }
      .pk-rec-box {
        border-radius: 16px;
        padding: 20px;
        display: flex;
        flex-direction: column;
      }
      .pk-rec-img {
        width: 60px;
        height: 60px;
        background: #fff;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 15px;
      }
      .pk-rec-img img { max-height: 80%; }
      .pk-rec-box h4 { margin: 0 0 10px 0; font-size: 18px; font-weight: 800; }
      .pk-rec-box p { font-size: 13px; margin: 0 0 20px 0; line-height: 1.5; flex-grow: 1; color: #595961; }
      .pk-rec-box .pk-dark-btn { width: 100%; font-size: 14px; }
      .pk-black-btn { background: #121217; }

      /* SUBSCRIPTION PLAN */
      .pk-active-badge {
        border: 1px solid #e8b923;
        color: #d19a0a;
        background: #fff;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: 700;
      }
      .pk-sub-stats-banner {
        background: #ffd831;
        border-radius: 12px;
        padding: 20px;
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 15px;
        margin-bottom: 30px;
      }
      .pk-sub-stats-banner label {
        display: block;
        font-size: 10px;
        font-weight: 800;
        margin-bottom: 6px;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .pk-sub-stats-banner span {
        font-size: 15px;
        font-weight: 600;
      }
      .pk-sub-items {
        border: 1px solid #eaeaea;
        border-radius: 12px;
        margin-bottom: 20px;
      }
      .pk-sub-item-row {
        display: flex;
        align-items: center;
        padding: 20px;
        border-bottom: 1px solid #eaeaea;
      }
      .pk-sub-item-row.no-border { border-bottom: none; }
      .pk-sub-img {
        width: 50px;
        height: 50px;
        margin-right: 20px;
      }
      .pk-sub-img img { width: 100%; height: 100%; object-fit: contain; }
      .pk-sub-info { flex-grow: 1; }
      .pk-sub-info h4 { margin: 0 0 4px 0; font-size: 16px; font-weight: 700; }
      .pk-sub-info p { margin: 0; font-size: 13px; color: #595961; }
      .pk-sub-actions {
        display: flex;
        align-items: center;
        gap: 20px;
      }
      .pk-sub-actions a { color: #595961; font-size: 13px; text-decoration: underline; font-weight: 600;}
      .pk-qty-box {
        border: 1px solid #eaeaea;
        padding: 6px 16px;
        border-radius: 20px;
        font-weight: 700;
        font-size: 14px;
      }
      .pk-sub-price { font-weight: 700; font-size: 16px; width: 60px; text-align: right; }
      
      .pk-sub-add-bar {
        background: #21252A;
        color: #fff;
        padding: 16px 20px;
        border-radius: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 14px;
        margin-bottom: 30px;
      }
      .pk-sub-add-bar a { color: #fff; text-decoration: underline; font-weight: 700; }
      
      .pk-sub-action-btns {
        display: flex;
        align-items: center;
        gap: 15px;
        margin-bottom: 30px;
        flex-wrap: wrap;
      }
      .pk-cancel-link { color: #8c8c9a; font-size: 13px; text-decoration: none; margin-left: auto; }
      
      .pk-sub-benefits-banner {
        background: #ffd831;
        border-radius: 12px;
        padding: 24px;
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 20px;
      }
      .pk-benefit strong { display: block; font-size: 14px; font-weight: 800; margin-bottom: 6px; }
      .pk-benefit p { margin: 0; font-size: 13px; color: #121217; }

      /* VET CARD */
      .pk-vet-card {
        background: #21252A;
        color: #fff;
        border-radius: 16px;
        padding: 30px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .pk-vet-card h3 { font-size: 24px; margin: 0 0 10px 0; font-family: var(--purrkins-heading-font); font-weight: 800;}
      .pk-vet-card p { margin: 0; font-size: 15px; color: #d1d1d1; }
      .pk-yellow-btn {
        background: #ffd831;
        color: #121217;
        padding: 12px 30px;
        border-radius: 30px;
        border: none;
        font-weight: 800;
        font-size: 15px;
        cursor: pointer;
      }

      .pk-outline-btn {
        border: 1px solid #121217;
        color: #121217;
        padding: 8px 20px;
        border-radius: 30px;
        text-decoration: none;
        font-size: 14px;
        font-weight: 700;
        display: inline-block;
        background: #fff;
        transition: 0.2s;
        cursor: pointer;
      }
      .pk-outline-btn:hover { background: #f9f9f9; }

      @media (max-width: 900px) {
        .pk-dashboard-layout { grid-template-columns: 1fr; }
        .pk-profile-details { flex-direction: column; }
        .pk-profile-stats { grid-template-columns: 1fr 1fr; }
        .pk-weight-banner { flex-direction: column; gap: 15px; align-items: flex-start; }
        .pk-recommend-grid { grid-template-columns: 1fr; }
        .pk-sub-stats-banner { grid-template-columns: 1fr 1fr; }
        .pk-sub-item-row { flex-direction: column; gap: 15px; align-items: flex-start; }
        .pk-sub-actions { width: 100%; justify-content: space-between; }
        .pk-sub-action-btns { flex-direction: column; align-items: stretch; }
        .pk-cancel-link { margin-left: 0; text-align: center; margin-top: 10px; }
        .pk-sub-benefits-banner { grid-template-columns: 1fr 1fr; }
        .pk-vet-card { flex-direction: column; gap: 20px; text-align: center; }
      }
    </style>

    <script>
      document.addEventListener("click", async function(e) {
        var link = e.target.closest("a.pk-menu-item");
        if (link && link.getAttribute("href").startsWith("/apps/purrkins/")) {
          e.preventDefault();
          
          document.querySelectorAll(".pk-menu-item").forEach(function(el) { el.classList.remove("active") });
          link.classList.add("active");
          
          var mainContent = document.querySelector(".pk-dashboard-content");
          if (!mainContent) return;
          mainContent.style.opacity = "0.5";
          mainContent.style.pointerEvents = "none";
          mainContent.style.transition = "opacity 0.2s";
          
          var url = link.getAttribute("href");
          window.history.pushState({}, "", url);
          
          try {
            var res = await fetch(url);
            var text = await res.text();
            
            var parser = new DOMParser();
            var doc = parser.parseFromString(text, "text/html");
            
            var newContent = doc.querySelector(".pk-dashboard-content");
            if (newContent) {
              mainContent.innerHTML = newContent.innerHTML;
              
              var scripts = mainContent.querySelectorAll("script");
              scripts.forEach(function(oldScript) {
                var newScript = document.createElement("script");
                Array.from(oldScript.attributes).forEach(function(attr) { newScript.setAttribute(attr.name, attr.value); });
                newScript.appendChild(document.createTextNode(oldScript.innerHTML));
                oldScript.parentNode.replaceChild(newScript, oldScript);
              });
            }
          } catch (err) {
             console.error("PJAX Error:", err);
             window.location.href = url;
          }
          
          mainContent.style.opacity = "1";
          mainContent.style.pointerEvents = "auto";
        }
      });
    </script>
  `;

  return new Response(liquidTemplate, {
    headers: {
      "Content-Type": "application/liquid",
    },
  });
};
